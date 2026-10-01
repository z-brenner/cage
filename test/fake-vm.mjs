// Plays an agent's VM for the web app's tests: what guest/app.mjs and cc-connect would write to its chat folder.
//   node test/fake-vm.mjs <chat folder, e.g. ~/.cage/app/claude> <work folder>
// A message gets a streamed reply; "email" asks before acting; "/usage" answers with a card; files come back.
import fs from 'node:fs'
import path from 'node:path'
const [dir, work] = process.argv.slice(2)
for (const d of ['in', 'out', 'files']) fs.mkdirSync(path.join(dir, d), { recursive: true })
fs.mkdirSync(work, { recursive: true })
const log = (e) => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ at: Date.now(), ...e }) + '\n')
const out = (id, d) => fs.writeFileSync(path.join(dir, 'out', id + '.json'), JSON.stringify(d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
log({ t: 'status', connected: true })
async function handle (r) {
  const session = r.session || 'you'
  if (r.type === 'message') {
    if (session === 'you') log({ t: 'you', session, id: r.id, text: r.text, files: (r.files || []).map((f) => ({ ...f, size: fs.statSync(path.join(dir, f.path)).size })) })
    if (r.text === '/usage') return log({ t: 'card', session, ctx: r.id, card: { header: { title: 'Usage' }, elements: [{ type: 'markdown', content: '**5-hour limit:** 42% used, resets in 2 h' }, { type: 'note', text: 'Weekly: 17% used' }] } })
    log({ t: 'typing', session, on: true })
    if (/email/i.test(r.text)) {
      await sleep(300)
      return log({ t: 'buttons', session, ctx: r.id, text: 'Allow tool execution: mcp__zapier__gmail_send_email(to: bob@acme.com)?', buttons: [[{ text: 'Allow', data: 'perm:allow' }, { text: 'Deny', data: 'perm:deny' }], [{ text: 'Allow all', data: 'perm:allow_all' }]] })
    }
    const handle = 'p-' + r.id
    log({ t: 'preview', session, ctx: r.id, handle, text: 'Working on it' })
    await sleep(400)
    log({ t: 'update', session, handle, text: 'Here’s what I found:\n\n- first point' })
    await sleep(400)
    log({ t: 'delete', session, handle })
    log({ t: 'reply', session, ctx: r.id, text: 'Here’s what I found:\n\n- **first** point\n- second point\n\nAnything else?' })
    for (const f of r.files || []) log({ t: 'file', session, kind: 'file', name: 'reviewed-' + f.name, path: f.path, mime: f.mime, size: 10 })
    log({ t: 'typing', session, on: false })
  } else if (r.type === 'action') {
    log({ t: 'action', session, id: r.id, action: r.action, label: r.label })
    log({ t: 'reply', session, ctx: r.id, text: r.action === 'perm:deny' ? 'Okay, I won’t send it.' : 'Sent the email to bob@acme.com.' })
  } else if (r.type === 'ls') {
    const p = path.join(work, r.path || '')
    out(r.id, { ok: true, path: r.path || '', entries: fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory(), size: d.isDirectory() ? 0 : fs.statSync(path.join(p, d.name)).size, at: Date.now() })) })
  } else if (r.type === 'fetch') {
    const rel = 'files/' + Date.now() + '-' + path.basename(r.path)
    fs.copyFileSync(path.join(work, r.path), path.join(dir, rel))
    out(r.id, { ok: true, path: rel, name: path.basename(r.path), size: fs.statSync(path.join(dir, rel)).size })
  } else if (r.type === 'put') {
    fs.copyFileSync(path.join(dir, r.from), path.join(work, r.dir || '', r.name))
    out(r.id, { ok: true, path: path.join(r.dir || '', r.name) })
  } else if (r.type === 'api') {
    out(r.id, { ok: true, data: { jobs: [] } })
  }
}
setInterval(async () => {
  for (const n of fs.readdirSync(path.join(dir, 'in')).filter((n) => n.endsWith('.json')).sort()) {
    const f = path.join(dir, 'in', n)
    const r = JSON.parse(fs.readFileSync(f, 'utf8'))
    fs.rmSync(f)
    await handle(r)
  }
}, 150)
