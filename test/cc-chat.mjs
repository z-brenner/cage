// Chat commands through a real cc-connect, sent the way the app sends them. test/host.sh runs this, when
// CAGE_TEST_CC_CONNECT is set, on the config cage writes for claude with /all on:
//   node test/cc-chat.mjs /path/to/cc-connect /path/to/cc-connect.toml
// The config runs as cage wrote it, but for what only works in a VM: its folders and ports are temporary ones, its
// chat apps give way to the placeholder cage uses when there are none, its hook is this checkout's guest/hook.sh,
// and claude is a stand-in (test/fixtures/fake-claude.mjs). The app's relay (guest/app.mjs) is the real one.
// Checks: /all in any case, /askall and @all reach the agent as "@all <your question>", exactly as you wrote it (with
// a picture, and while it's busy too), and reach guest/hook.sh as you typed them; the hook asks your other agents the
// same question, and only when the agent got one. /allow (cc-connect's own, which pre-allows a tool) is off, and
// nothing typed here pre-allows a tool.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeFlags } from './fixtures/fake-bridge.mjs'

const [CC, CONF] = process.argv.slice(2)
if (!CC || !CONF) { console.error('usage: node test/cc-chat.mjs <cc-connect> <cc-connect.toml>'); process.exit(2) }
const ROOT = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cage-cc-chat-')))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const jsonl = (f) => lines(f).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })   // (a line still being written)
async function until (what, fn, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = fn()
    if (v) return v
  }
  throw new Error('timed out waiting for ' + what)
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const listening = (port) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1', () => { c.destroy(); resolve(true) }).once('error', () => resolve(false))
})

// --- cage's config, made to run here ----------------------------------------------------------------------------
async function localConfig () {
  const ports = { bridge: await freePort(), mgmt: await freePort(), line: await freePort() }
  let toml = fs.readFileSync(CONF, 'utf8')
  const swap = (re, to, what) => {
    if (!re.test(toml)) throw new Error(`no ${what} in ${CONF}: has cage's config changed?\n${toml}`)
    toml = toml.replace(re, to)
  }
  const token = (toml.match(/^\[bridge\]\n(?:[^[\n].*\n)*?token = "(\w+)"$/m) || [])[1]
  if (!token) throw new Error(`no [bridge] token in ${CONF}`)
  const configured = ((toml.match(/^allowed_tools = \[(.*)\]$/m) || [])[1] || '').split(',')
    .map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
  swap(/^data_dir = ".*"$/m, `data_dir = "${T}/data"`, 'data_dir')
  swap(/^port = 9810$/m, `port = ${ports.bridge}`, "the bridge's port")
  swap(/^port = 9820$/m, `port = ${ports.mgmt}`, "the management API's port")
  swap(/^work_dir = ".*"$/m, `work_dir = "${T}/work"`, 'work_dir')
  swap(/\/bin\/bash \/cage\/hook\.sh /g, `/bin/bash '${ROOT}/guest/hook.sh' `, 'guest/hook.sh')
  toml = toml.replace(/^cmd = .*\n/m, '')
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/fake-claude.mjs'), path.join(T, 'fake-claude.mjs'))
  swap(/^\[projects\.agent\.options\]\n/m, `$&cmd = "${process.execPath} ${T}/fake-claude.mjs"\n`, '[projects.agent.options]')
  // the chat apps are the config's last part; nothing else may be in it
  const apps = toml.indexOf('\n[[projects.platforms]]\n')
  if (apps < 0) throw new Error(`no chat app in ${CONF}`)
  const other = toml.slice(apps).match(/^\[.*\]$/gm).filter((h) => !['[[projects.platforms]]', '[projects.platforms.options]'].includes(h))
  if (other.length) throw new Error(`${other.join(', ')} after the chat apps in ${CONF}: this test drops them`)
  toml = toml.slice(0, apps) + `
[[projects.platforms]]
type = "line"

[projects.platforms.options]
channel_secret = "${'s'.repeat(32)}"
channel_token = "${'t'.repeat(32)}"
allow_from = "nobody"
port = "${ports.line}"
`
  // and one more hook, that notes what it's given (each message ends with a NUL: one can be several lines)
  fs.writeFileSync(path.join(T, 'seen.sh'), `printf '%s\\0' "$CC_HOOK_CONTENT" >> '${T}/seen.txt'\n`)
  toml = toml.replace(/^\[\[projects\]\]$/m,
    `[[hooks]]\nevent = "message.received"\ntype = "command"\ncommand = "/bin/sh '${T}/seen.sh'"\ntimeout = 10\n\n$&`)
  const conf = path.join(T, 'cc-connect.toml')
  fs.writeFileSync(conf, toml, { mode: 0o600 })
  return { conf, ports, token, configured }
}

// --- cc-connect and the app's relay ----------------------------------------------------------------------------
const OUTBOX = path.join(T, 'outbox')
const APP = path.join(T, 'app')
for (const d of [OUTBOX, path.join(T, 'home'), path.join(T, 'work'), ...['in', 'out', 'files'].map((s) => path.join(APP, s))]) {
  fs.mkdirSync(d, { recursive: true })
}
const AGENT = path.join(T, 'agent.jsonl')
const procs = []
function start (name, cmd, args, env) {
  const log = fs.openSync(path.join(T, name + '.log'), 'a')
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', log, log], detached: true })
  procs.push(p)
  return p
}
async function stop () {
  for (const p of procs.reverse()) {
    if (p.exitCode !== null || p.signalCode !== null) continue
    const gone = new Promise((resolve) => p.once('exit', resolve))
    try { process.kill(-p.pid, 'SIGTERM') } catch {}
    if (await Promise.race([gone.then(() => true), sleep(5000)]) !== true) try { process.kill(-p.pid, 'SIGKILL') } catch {}
  }
  for (const pid of new Set(jsonl(AGENT).map((e) => e.pid))) {   // each in its own process group: any still there?
    try {
      if (execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).includes(T)) process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

const problems = []
try {
  const { conf, ports, token, configured } = await localConfig()
  start('cc-connect', CC, ['--config', conf], { HOME: path.join(T, 'home'), CAGE_OUTBOX: OUTBOX, FAKE_CLAUDE_LOG: AGENT })
  for (const end = Date.now() + 15000; !(await listening(ports.bridge)); await sleep(100)) {
    if (Date.now() > end || procs[0].exitCode !== null) throw new Error("cc-connect didn't start")
  }
  start('relay', process.execPath, [...nodeFlags, fs.realpathSync(path.join(ROOT, 'guest/app.mjs'))], {
    APP_DIR: APP, APP_WORK: path.join(T, 'work'), APP_TOKEN: token,
    APP_BRIDGE_URL: `ws://127.0.0.1:${ports.bridge}/bridge/ws`, APP_MGMT_URL: `http://127.0.0.1:${ports.mgmt}`
  })
  const chat = () => jsonl(path.join(APP, 'log.jsonl'))
  await until('the relay to connect', () => chat().some((e) => e.t === 'status' && e.connected))

  // what the app does (host/ui/server.py): a request in in/, written then renamed. Each case in its own chat, so none
  // waits for another.
  let n = 0
  const say = (session, text, files) => {
    const id = `${String(++n).padStart(4, '0')}-test`
    fs.writeFileSync(path.join(APP, 'in', `.${id}.tmp`), JSON.stringify({ id, type: 'message', session, text, files }))
    fs.renameSync(path.join(APP, 'in', `.${id}.tmp`), path.join(APP, 'in', `${id}.json`))
  }
  const said = (session) => chat().filter((e) => e.session === session && e.t !== 'typing' && e.t !== 'status')
    .map((e) => e.text ?? JSON.stringify(e.card ?? e.buttons ?? '')).filter(Boolean)
  // what the agent got: its text (without the note cc-connect adds about where it saved a picture), and its pictures
  const heard = () => jsonl(AGENT).filter((e) => 'message' in e)
    .map((e) => ({ text: e.message.replace(/\n\n\(Images also saved locally: [^\n]*\)$/, ''), images: e.images }))
  const requests = () => fs.readdirSync(OUTBOX).filter((d) => !d.startsWith('.')).map((d) => {
    const r = (f) => fs.readFileSync(path.join(OUTBOX, d, f), 'utf8')
    return { kind: r('kind'), session: r('session'), text: r('text') }
  })
  const asked = (session) => requests().filter((r) => r.session === `app:${session}:you`).map((r) => `${r.kind}: ${r.text}`)
  const seen = () => { try { return fs.readFileSync(path.join(T, 'seen.txt'), 'utf8').split('\0').slice(0, -1) } catch { return [] } }
  const shown = (session) => `the chat says: ${JSON.stringify(said(session))}`
  const json = JSON.stringify
  // over when the agent answered, or cc-connect did instead
  const over = (session) => until(`an answer in ${session}`, () => said(session).some((t) => /ok: |pre-allowed|disabled/.test(t)))

  // typed: what you send. agent: what the agent gets (null: nothing, and cc-connect says /allow is off). others: the
  // question your other agents are asked (null: none).
  const ask = (typed) => {
    const question = typed.replace(/^\s*\S+ /, '')
    return { typed, agent: '@all ' + question, others: question }
  }
  const off = (typed) => ({ typed, agent: null, others: null })
  fs.writeFileSync(path.join(APP, 'files', 'dot.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
  const cases = [
    ask('/all Write a poem about spring'), ask('/All Write a haiku'), ask('/ALL Write a limerick'),
    ask('/aLl Write a sonnet'), ask('/askall Write an ode'), ask('/AskAll Write a ballad'), ask('@all Write an elegy'),
    // the question just as you wrote it
    ask(`/all What's the user's name? Say "hi" to them.`),
    ask('/all Fix this:\n    if x:\n        return 1'),
    ask(`/all echo "$HOME" and 'single'  a  b   c`),
    { ...ask('/all Describe this picture'), files: [{ path: 'files/dot.png', mime: 'image/png', name: 'dot.png' }] },
    // nothing to ask: the agent gets "@all", not an empty message
    { typed: '/all', agent: '@all', others: null },
    // cc-connect's /allow, however it's written
    off('/allow Bash'), off('/ALLOW Bash'), off('/allo Bash')
  ]
  for (const [i, c] of cases.entries()) {
    c.session = `case${i}`
    const before = heard().length
    say(c.session, c.typed, c.files)
    try {
      await over(c.session)
      const got = heard().slice(before)
      const want = c.agent === null ? [] : [{ text: c.agent, images: c.files ? 1 : 0 }]
      if (json(got) !== json(want)) problems.push(`${json(c.typed)}: the agent got ${json(got)}, not ${json(want)}; ${shown(c.session)}`)
      if (c.agent === null && !said(c.session).some((t) => /\/allow\b.*disabled/s.test(t))) {
        problems.push(`${json(c.typed)}: cc-connect didn't say /allow is off; ${shown(c.session)}`)
      }
    } catch (e) { problems.push(`${json(c.typed)}: ${e.message}; ${shown(c.session)}`) }
  }

  // While the agent is busy, /all waits its turn, like any message
  const slow = 'Take your time over this one'
  const busy = { typed: '/all Write while busy', session: 'busy', others: 'Write while busy' }
  say('busy', slow)
  try {
    await until('the agent to start on the slow one', () => heard().some((e) => e.text === slow))
    say('busy', busy.typed)
    await until('the agent to get /all after the slow one', () => heard().some((e) => e.text === '@all Write while busy'), 20000)
  } catch (e) { problems.push(`${json(busy.typed)} while the agent is busy: ${e.message}; ${shown('busy')}`) }
  if (said('busy').some((t) => /still processing/i.test(t))) problems.push(`${json(busy.typed)} while the agent is busy: ${shown('busy')}`)

  // guest/hook.sh was given each message as typed, and asked the others the agent's question, when it got one
  const hooked = [...cases, busy]
  await until('the hooks', () => hooked.every((c) => seen().includes(c.typed)), 10000)
    .catch(() => problems.push(`the hooks weren't given every message as typed: they saw ${json(seen())}`))
  await until('guest/hook.sh', () => hooked.every((c) => c.others === null || asked(c.session).length), 10000).catch(() => {})
  await sleep(500)   // (and for any it shouldn't have asked)
  for (const c of hooked) {
    const want = c.others === null ? [] : [`ask: ${c.others}`]
    if (json(asked(c.session)) !== json(want)) problems.push(`${json(c.typed)}: guest/hook.sh asked the others ${json(asked(c.session))}, not ${json(want)}`)
  }
  const sessions = hooked.map((c) => `app:${c.session}:you`)
  const stray = requests().filter((r) => !sessions.includes(r.session))
  if (stray.length) problems.push(`guest/hook.sh asked the others from another chat: ${json(stray)}`)

  // A tool cc-connect pre-allows is on the command line of the agent's next session: start one, and look.
  say('after', 'Hello again')
  try {
    await until('the agent to answer in a new chat', () => heard().some((e) => e.text === 'Hello again'))
    const pid = jsonl(AGENT).find((e) => e.message === 'Hello again').pid
    const args = jsonl(AGENT).find((e) => e.pid === pid && e.args).args
    const i = args.indexOf('--allowedTools')
    const extra = (i < 0 ? [] : args[i + 1].split(',')).filter((t) => !configured.includes(t))
    if (extra.length) problems.push(`pre-allowed: ${extra.join(', ')} (claude's next session started with: ${args.join(' ')})`)
  } catch (e) { problems.push(`a new chat: ${e.message}`) }
  const pre = chat().filter((e) => /pre-allowed/.test(e.text || ''))
  if (pre.length) problems.push(`cc-connect pre-allowed tools: ${json(pre.map((e) => [e.session, e.text]))}`)
} catch (e) {
  problems.push(e.message)
} finally {
  await stop()
}
if (problems.length) {
  console.error(problems.map((p) => '- ' + p).join('\n'))
  for (const f of ['cc-connect.log', 'relay.log']) console.error(`--- the end of ${f}:\n` + lines(path.join(T, f)).slice(-15).join('\n'))
}
fs.rmSync(T, { recursive: true, force: true })
process.exit(problems.length ? 1 : 0)
