// cage's chat in the app. It relays between the app on your computer and cc-connect's bridge in this VM, through
// /cage-app, a folder your computer shares with this VM (see app_dirs in cage):
//   in/<n>.json    what you send from the app, handed to cc-connect in name order and then removed
//   log.jsonl      everything said, one JSON object per line; the app reads it (it's kept while the app is closed,
//                  so scheduled tasks' results are there when you come back)
//   files/         files either way: the agent's attachments land here, and yours are read from here
//   out/<id>.json  answers to the app's other requests: scheduled tasks (cc-connect's management API) and the
//                  agent's work folder (list, fetch, put)
//   cc-connect.json  when cc-connect started, as the relay last saw it
// Started by guest/app.sh as the agent user, with APP_DIR, APP_BRIDGE_URL, APP_MGMT_URL, APP_TOKEN and APP_WORK in
// its environment. Node 22's own WebSocket and fetch; no packages. test/relay.test.mjs runs it against a fake bridge.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MAX_FILE = 25 * 1024 * 1024
const MAX_LOG = 8 * 1024 * 1024
const HOUR = 3600 * 1000

// What the relay tells cc-connect it takes. cc-connect sends a kind of message only if it's listed here (a video
// fails instead of arriving), so every kind the relay handles must be in it (test/app.test.mjs checks).
export const CAPABILITIES = ['text', 'image', 'file', 'audio', 'video', 'card', 'buttons', 'typing', 'update_message',
  'preview', 'delete_message', 'reconstruct_reply']
const MEDIA = ['image', 'file', 'audio', 'video']

// --- pure helpers (test/app.test.mjs) ------------------------------------------------------------------------------
// One person ("you") talks to the agent; "session" names a conversation: "you" is the chat, "usage" asks for the
// plan's usage without showing up in it.
export const sessionKey = (s) => `app:${/^[a-z0-9-]{1,32}$/.test(s || '') ? s : 'you'}:you`
export const sessionOf = (key) => (String(key || '').match(/^app:([a-z0-9-]{1,32}):/) || [])[1] || 'you'

export function safeName (name) { // a plain file name: no folders, no leading dots, nothing odd
  const base = path.basename(String(name || '')).replace(/[^\w.\- ()+,@]+/g, '_').replace(/^[.\s]+/, '').slice(-120)
  return base || 'file'
}

// Where a file goes in files/: <ms>-<4 hex>-<name>, like the app's own uploads. The app strips exactly that prefix
// to show the name, so "q3-results.txt" stays "q3-results.txt".
export const sharedName = (name) => `files/${Date.now()}-${crypto.randomBytes(2).toString('hex')}-${safeName(name)}`

// Buttons as cc-connect sends them (its Go names, Text/Data, or the documented text/data), as [[{text, data}]].
export const buttonsOf = (rows) => (Array.isArray(rows) ? rows : []).map((row) =>
  (Array.isArray(row) ? row : [row]).map((b) => ({ text: String(b?.text ?? b?.Text ?? ''), data: String(b?.data ?? b?.Data ?? '') }))
    .filter((b) => b.text && b.data)).filter((row) => row.length)

// What cc-connect sent, as a line for the log (files are written separately, see saveFile). null: nothing to log.
export function entryOf (m) {
  const session = sessionOf(m.session_key)
  const ctx = m.reply_ctx === undefined ? undefined : String(m.reply_ctx)
  switch (m.type) {
    case 'reply': return { t: 'reply', session, ctx, text: String(m.content ?? ''), format: m.format || 'text' }
    case 'buttons': return { t: 'buttons', session, ctx, text: String(m.content ?? ''), buttons: buttonsOf(m.buttons) }
    case 'card': return { t: 'card', session, ctx, card: m.card || {} }
    case 'update_message': return { t: 'update', session, handle: String(m.preview_handle ?? ''), text: String(m.content ?? '') }
    case 'delete_message': return { t: 'delete', session, handle: String(m.preview_handle ?? '') }
    case 'typing_start': return { t: 'typing', session, on: true }
    case 'typing_stop': return { t: 'typing', session, on: false }
    case 'error': return { t: 'error', session, text: String(m.message || m.code || 'error') }
    default: return null
  }
}

// The kinds of message from cc-connect that the relay acts on (besides register_ack and pong).
export const handles = (type) => type === 'preview_start' || MEDIA.includes(type) || entryOf({ type }) !== null

// A path inside the agent's work folder, or null if it would leave it.
export function inWork (work, rel) {
  const p = path.resolve(work, String(rel || '.').replace(/^\/+/, ''))
  return p === work || p.startsWith(work + path.sep) ? p : null
}

// The management API paths the app may call: scheduled tasks, and cc-connect's status.
export const apiAllowed = (method, p) => /^\/api\/v1\/(cron(\/[\w-]+(\/exec)?)?|status)(\?[\w=&%.-]*)?$/.test(String(p || '')) &&
  ['GET', 'POST', 'DELETE', 'PATCH'].includes(method)

// Keeps the chat folder from growing forever on your computer's disk. A file in files/ that log.jsonl, log.1.jsonl
// or a request still waiting in in/ mentions is always kept. Any other goes once it's older than 7 days, or, while
// files/ holds more than 2 GB, oldest first (but not in its first hour: it may be an upload about to be sent, or a
// download the app is about to fetch). Answers in out/ that the app never picked up go after 10 minutes.
export function tidy (dir, { now = Date.now(), keep = 7 * 24 * HOUR, max = 2 * 1024 ** 3, fresh = HOUR, answers = 10 * 60 * 1000 } = {}) {
  const used = new Set()
  const waiting = (() => { try { return fs.readdirSync(path.join(dir, 'in')).map((n) => path.join('in', n)) } catch { return [] } })()
  for (const rel of ['log.jsonl', 'log.1.jsonl', ...waiting]) {
    let text
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8') } catch { continue }
    for (const m of text.matchAll(/"(files\\?\/(?:[^"\\]|\\.)*)"/g)) { // as JSON strings, so escaped names count too
      try { used.add(JSON.parse(`"${m[1]}"`)) } catch {}
    }
  }
  const files = []
  let total = 0
  for (const name of (() => { try { return fs.readdirSync(path.join(dir, 'files')) } catch { return [] } })()) {
    try {
      const st = fs.lstatSync(path.join(dir, 'files', name))
      if (st.isDirectory()) continue
      total += st.size
      if (!used.has(`files/${name}`)) files.push({ name, size: st.size, at: st.mtimeMs })
    } catch {}
  }
  let removed = 0
  let freed = 0
  const drop = (f) => {
    try { fs.rmSync(path.join(dir, 'files', f.name), { force: true }); removed++; freed += f.size; total -= f.size } catch {}
  }
  files.sort((a, b) => a.at - b.at)
  for (const f of files) if (now - f.at > keep) drop(f)
  for (const f of files) if (total > max && now - f.at > fresh && now - f.at <= keep) drop(f)
  for (const name of (() => { try { return fs.readdirSync(path.join(dir, 'out')) } catch { return [] } })()) {
    const p = path.join(dir, 'out', name)
    try {
      const st = fs.lstatSync(p)
      if (!st.isDirectory() && now - st.mtimeMs > answers) fs.rmSync(p, { force: true })
    } catch {}
  }
  return { removed, freed }
}

// --- the relay -----------------------------------------------------------------------------------------------------
async function main () {
  const DIR = process.env.APP_DIR || '/cage-app'
  const TOKEN = process.env.APP_TOKEN || ''
  const BRIDGE = `${process.env.APP_BRIDGE_URL || 'ws://127.0.0.1:9810/bridge/ws'}?token=${encodeURIComponent(TOKEN)}`
  const MGMT = process.env.APP_MGMT_URL || 'http://127.0.0.1:9820'
  const WORK = fs.realpathSync(process.env.APP_WORK || '/home/agent/work')
  const LOG = path.join(DIR, 'log.jsonl')
  const say = (...a) => console.log('cage-app:', ...a)
  for (const d of ['in', 'out', 'files']) fs.mkdirSync(path.join(DIR, d), { recursive: true })
  process.umask(0o022)   // the app on your computer reads what's written here
  // One bad moment (an odd message, a hiccup on the shared folder) mustn't take the relay down: while it restarts,
  // cc-connect has nowhere to send replies, and they're lost.
  process.on('uncaughtException', (e) => say('unexpected error (still running):', e?.stack || e))

  // Writes to the shared folder. If they fail (your computer's disk is full, say), that's said once, not on every
  // message, and the relay keeps going.
  const failing = new Set()
  const write = (what, fn) => {
    try { fn(); failing.delete(what); return true } catch (e) {
      if (!failing.has(what)) say(`couldn't write ${what} (is your computer's disk full?):`, e.message)
      failing.add(what)
      return false
    }
  }
  const log = (e) => {
    try {
      if (fs.statSync(LOG).size > MAX_LOG) fs.renameSync(LOG, path.join(DIR, 'log.1.jsonl'))   // the app starts over
    } catch {}
    write('the chat log', () => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...e }) + '\n'))
  }
  const out = (id, data) => {
    const f = path.join(DIR, 'out', safeName(id) + '.json')
    fs.writeFileSync(f + '.tmp', JSON.stringify(data))
    fs.renameSync(f + '.tmp', f)
  }
  const saveFile = (name, data, kind, session, mime) => {
    const rel = sharedName(name)
    const buf = Buffer.from(String(data || ''), 'base64')
    if (write('a file from the agent', () => fs.writeFileSync(path.join(DIR, rel), buf))) {
      log({ t: 'file', session, kind, name: safeName(name), path: rel, mime: mime || '', size: buf.length })
    } else {
      log({ t: 'error', session, text: `The agent sent ${safeName(name)}, but it couldn't be saved on your computer.` })
    }
  }
  const readShared = (rel) => { // a file the app put in files/, for cc-connect
    if (!/^files\/[^/]+$/.test(rel)) throw new Error('not a shared file: ' + rel)
    const p = path.join(DIR, rel)
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > MAX_FILE) throw new Error('not a file, or too big: ' + rel)
    return fs.readFileSync(p).toString('base64')
  }
  const tidyUp = () => {
    try {
      const { removed, freed } = tidy(DIR)
      if (removed) say(`tidied the chat folder: removed ${removed} old file(s), ${Math.round(freed / 1e6)} MB`)
    } catch (e) { say('couldn\'t tidy the chat folder:', e.message) }
  }
  tidyUp()
  setInterval(tidyUp, HOUR)

  // streaming previews: write at most every 600 ms per message, and always the last version
  const pending = new Map()
  const update = (e) => {
    const p = pending.get(e.handle) || { last: 0, timer: null, e: null }
    p.e = e
    pending.set(e.handle, p)
    const flush = () => { p.timer = null; p.last = Date.now(); if (p.e) log(p.e); p.e = null }
    if (Date.now() - p.last >= 600) flush()
    else if (!p.timer) p.timer = setTimeout(flush, 600)
  }
  const settle = (handle) => { const p = pending.get(handle); if (p) { clearTimeout(p.timer); if (p.e) log(p.e); pending.delete(handle) } }

  // --- cc-connect's bridge --------------------------------------------------------------------------------------
  let ws = null
  let ready = false
  let delay = 1000
  const send = (o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)) }
  // cc-connect keeps what it waits for (your OK, say) only in memory, so the app reads the relay registering with it
  // again as cc-connect having started afresh, and stops offering answers to what it asked before. When it's the
  // same cc-connect (the connection dropped, or the relay itself restarted), the status line says so ("same": true).
  // That's by when it started, from its management API's uptime (in whole seconds, so to within a second and a half),
  // kept in cc-connect.json so the relay knows it after a restart of its own; what it can't tell, it doesn't say.
  // (Another cc-connect starts later than that: guest/entry.sh waits 5 s before it starts one again, and /restart
  // ends one that has been asked something, which takes longer.) Until it's asked, what cc-connect sends, and what
  // goes to it, waits: the status line comes first.
  const STARTED = path.join(DIR, 'cc-connect.json')
  let started = (() => { try { return Number(JSON.parse(fs.readFileSync(STARTED, 'utf8')).started) || 0 } catch { return 0 } })()
  const startedAt = async () => {
    try {
      const res = await fetch(MGMT + '/api/v1/status', { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(3000) })
      const up = (await res.json())?.data?.uptime_seconds
      return Number.isFinite(up) && up >= 0 ? Date.now() - up * 1000 : 0
    } catch { return 0 }
  }
  let held = null   // while the relay asks cc-connect when it started: what to do once it knows
  const canSend = () => ready && !held && ws?.readyState === WebSocket.OPEN
  function registered () {
    held = []
    startedAt().then((at) => {
      log({ t: 'status', connected: true, ...(at && started && Math.abs(at - started) < 1500 ? { same: true } : {}) })
      if (at) {
        started = at
        write('when cc-connect started', () => fs.writeFileSync(STARTED, JSON.stringify({ started })))
      }
      const then = held
      held = null
      for (const f of then) f()
    })
  }
  const take = (m) => { try { onFrame(m) } catch (e) { say('bad frame from cc-connect:', e.message) } }
  function onFrame (m) {
    if (held) { held.push(() => take(m)); return }
    if (m.type === 'register_ack') {
      ready = !!m.ok
      if (ready) { delay = 1000; registered() } else say('bridge refused:', m.error)
      return
    }
    if (!handles(m.type)) return
    const session = sessionOf(m.session_key)
    if (m.type === 'preview_start') {
      const handle = `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      send({ type: 'preview_ack', ref_id: m.ref_id, preview_handle: handle })
      log({ t: 'preview', session, ctx: String(m.reply_ctx ?? ''), handle, text: String(m.content ?? '') })
      return
    }
    if (MEDIA.includes(m.type)) {
      const ext = m.type === 'audio' ? '.' + (m.format || 'mp3') : m.type === 'video' ? '.' + (m.format || 'mp4') : ''
      saveFile(m.file_name || `${m.type}${ext}`, m.data, m.type, session, m.mime_type)
      return
    }
    const e = entryOf(m)
    if (e.t === 'update') return update(e)
    if (e.t === 'delete') settle(e.handle)
    else if (e.t !== 'typing') for (const h of [...pending.keys()]) settle(h)   // a preview's last words come first
    log(e)
  }
  function connect () {
    const sock = new WebSocket(BRIDGE)
    ws = sock
    sock.addEventListener('open', () => {
      send({ type: 'register', platform: 'app', capabilities: CAPABILITIES, metadata: { description: "cage's app" } })
    })
    sock.addEventListener('message', (ev) => {
      let m
      try { m = JSON.parse(String(ev.data)) } catch { return }
      if (!m || typeof m !== 'object') return
      take(m)
    })
    // Node's WebSocket says 'error' and never 'close' when nothing is listening (cc-connect restarting), so either
    // one means this connection is over: try again.
    const lost = () => {
      if (ws !== sock) return
      if (ready) { const note = () => log({ t: 'status', connected: false }); held ? held.push(note) : note() }
      ready = false
      ws = null
      try { sock.close() } catch {}
      setTimeout(connect, delay)
      delay = Math.min(delay * 2, 30000)
    }
    sock.addEventListener('close', lost)
    sock.addEventListener('error', lost)
  }
  connect()
  setInterval(() => send({ type: 'ping', ts: Date.now() }), 30000)

  // --- what the app sends --------------------------------------------------------------------------------------
  async function handle (r) {
    const id = String(r.id || Date.now())
    const session = /^[a-z0-9-]{1,32}$/.test(r.session || '') ? r.session : 'you'
    if (r.type === 'message') {
      const images = []
      const files = []
      const shown = []
      for (const f of Array.isArray(r.files) ? r.files.slice(0, 10) : []) {
        const data = readShared(String(f.path))
        const mime = String(f.mime || 'application/octet-stream')
        const item = { mime_type: mime, data, file_name: safeName(f.name) }
        if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) images.push(item); else files.push(item)
        shown.push({ name: safeName(f.name), path: String(f.path), mime, size: Buffer.byteLength(data, 'base64') })
      }
      send({ type: 'message', msg_id: id, session_key: sessionKey(session), user_id: 'you', user_name: 'You',
        content: String(r.text || ''), reply_ctx: id, images, files })
      if (session === 'you') log({ t: 'you', session, id, text: String(r.text || ''), files: shown })
    } else if (r.type === 'action') {
      send({ type: 'card_action', session_key: sessionKey(session), action: String(r.action || ''), reply_ctx: id })
      log({ t: 'action', session, id, action: String(r.action || ''), label: String(r.label || '') })
    } else if (r.type === 'api') {
      const method = String(r.method || 'GET').toUpperCase()
      if (!apiAllowed(method, r.path)) return out(id, { ok: false, error: 'not allowed' })
      try {
        const res = await fetch(MGMT + r.path, {
          method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: r.body === undefined ? undefined : JSON.stringify(r.body), signal: AbortSignal.timeout(15000)
        })
        out(id, await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })))
      } catch (e) {
        out(id, { ok: false, error: e?.cause?.code === 'ECONNREFUSED' ? "the agent's chat service isn't running right now; try again in a minute" : String(e.message || e) })
      }
    } else if (r.type === 'ls') {
      const dir = inWork(WORK, r.path)
      if (!dir) return out(id, { ok: false, error: 'outside the work folder' })
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).slice(0, 500).map((d) => {
          let st = {}
          try { st = fs.statSync(path.join(dir, d.name)) } catch {}
          return { name: d.name, dir: d.isDirectory(), size: st.size || 0, at: st.mtimeMs || 0 }
        })
        out(id, { ok: true, path: path.relative(WORK, dir), entries })
      } catch (e) { out(id, { ok: false, error: e.code === 'ENOENT' ? 'not found' : String(e.message || e) }) }
    } else if (r.type === 'fetch') {
      const p = inWork(WORK, r.path)
      try {
        const real = p && fs.realpathSync(p)
        if (!real || !inWork(WORK, path.relative(WORK, real))) throw new Error('outside the work folder')
        const st = fs.statSync(real)
        if (!st.isFile() || st.size > MAX_FILE) throw new Error(st.isFile() ? 'too big (25 MB at most)' : 'not a file')
        const rel = sharedName(path.basename(real))
        fs.copyFileSync(real, path.join(DIR, rel))
        out(id, { ok: true, path: rel, name: path.basename(real), size: st.size })
      } catch (e) { out(id, { ok: false, error: String(e.message || e) }) }
    } else if (r.type === 'put') {
      const dir = inWork(WORK, r.dir)
      try {
        if (!dir) throw new Error('outside the work folder')
        const name = safeName(r.name)
        let dest = path.join(dir, name)
        for (let i = 2; fs.existsSync(dest) && i < 100; i++) dest = path.join(dir, name.replace(/(\.[^.]*)?$/, ` (${i})$1`))
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(dest, Buffer.from(readShared(String(r.from)), 'base64'), { flag: 'wx' })
        out(id, { ok: true, path: path.relative(WORK, dest) })
      } catch (e) { out(id, { ok: false, error: String(e.message || e) }) }
    }
  }

  // Messages and button presses go to cc-connect in order, so while it's away they wait in in/: once one has to
  // wait, every later one waits behind it. The other requests don't need it and are answered meanwhile (the work
  // folder at once; scheduled tasks get a quick "not running" rather than running late, after the app gave up).
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const names = fs.readdirSync(path.join(DIR, 'in')).filter((n) => /^[\w-]+\.json$/.test(n)).sort()
      let blocked = false
      for (const n of names) {
        const f = path.join(DIR, 'in', n)
        let r = null
        try { r = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
        if (r && ['message', 'action'].includes(r.type) && (blocked || !canSend())) { blocked = true; continue }
        fs.rmSync(f, { force: true })
        if (!r) continue
        try { await handle(r) } catch (e) { log({ t: 'error', session: r.session || 'you', text: String(e.message || e) }); say(e) }
      }
    } catch (e) { say(e.message || e) }
    busy = false
  }, 300)
  say('relaying', DIR, '<->', BRIDGE.replace(/token=[^&]+/, 'token=…'))
}

if (import.meta.url === `file://${process.argv[1]}`) main()
