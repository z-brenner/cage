// cage's web app. Everything it does is a cage command (a "job", see host/ui/server.py): the page shows cage's
// messages as a conversation, asks its questions with real input boxes, and opens a terminal view only when a
// vendor's own screen needs one (signing in, logs). What it shows comes from `cage _state`.
'use strict'

const AGENT_COLORS = { claude: 'var(--claude)', codex: 'var(--codex)', cursor: 'var(--cursor)', antigravity: 'var(--antigravity)' }
const FACES = { ready: '[•|•]', login: '[o|o]', installing: '[•|-]', asleep: '[-|-]', none: '[ | ]', stuck: '[x|x]' }
const STATE_LABEL = { ready: 'ready', login: 'needs you to sign in', installing: 'installing…', asleep: 'asleep', none: 'no cage yet', stuck: 'stuck' }
const PAGES = ['home', 'chats', 'apps', 'signins', 'memory', 'security', 'settings']

let TOKEN = ''
let STATE = null
let LATEST = ''
let page = 'home'

// --- tiny DOM helpers: text always goes in as text, never as HTML ------------------------------------------------
function h (tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, x] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, x); else el.style[p] = x }
    }
    else if (k === 'class') el.className = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return el
}
const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g
function linkify (text) { // text with its http(s) links made clickable
  const out = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
function face (state, agent) {
  return h('span', { class: 'face' + (state === 'installing' ? ' blink' : ''), style: { '--c': AGENT_COLORS[agent] } }, FACES[state] || FACES.none)
}
function ago (t) {
  const d = Math.max(0, Date.now() / 1000 - t)
  if (d < 90) return 'just now'
  if (d < 5400) return Math.round(d / 60) + ' min ago'
  if (d < 129600) return Math.round(d / 3600) + ' h ago'
  return Math.round(d / 86400) + ' days ago'
}
function newer (latest, current) { // is release `latest` (v1.2.3) newer than what's installed? (dev builds: never asked)
  const v = (x) => (/^v(\d+)\.(\d+)\.(\d+)/.exec(x || '') || []).slice(1).map(Number)
  const a = v(latest)
  const b = v(current)
  if (a.length !== 3 || b.length !== 3) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}
function size (n) { return n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' kB' }

// --- talking to the server ---------------------------------------------------------------------------------------
async function api (path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'X-Cage-Token': TOKEN, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  if (res.status === 401) { locked(); throw new Error('locked') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
async function refresh () {
  try {
    STATE = await api('/api/state')
    render()
  } catch (e) { if (e.message !== 'locked') console.warn(e) }
}
function locked () {
  document.getElementById('nav').hidden = true
  const main = document.getElementById('main')
  main.replaceChildren(document.getElementById('tpl-locked').content.cloneNode(true))
}

// --- jobs: a cage command, as a conversation ----------------------------------------------------------------------
const dlg = document.getElementById('job')
let job = null
async function runJob (args, title, onDone) {
  if (job && !job.done) return
  const log = document.getElementById('job-log')
  const termEl = document.getElementById('job-term')
  log.replaceChildren()
  termEl.hidden = true
  termEl.replaceChildren()
  document.getElementById('job-title').textContent = title || ('cage ' + args.join(' '))
  dlg.showModal()
  let id
  try { id = (await api('/api/jobs', { method: 'POST', body: { args } })).id } catch (e) {
    log.append(msg('bad', '✗', e.message)); return
  }
  job = { id, done: false, term: null, onDone }
  const es = new EventSource(`/api/jobs/${id}/events?from=0&token=${encodeURIComponent(TOKEN)}`)
  job.es = es
  es.onmessage = (m) => handle(JSON.parse(m.data))
  es.onerror = () => { if (job && job.done) es.close() }
}
async function quietJob (args) { // a command whose output nobody needs to see (marking events as seen)
  try { await api('/api/jobs', { method: 'POST', body: { args } }) } catch (e) {}
}
function msg (cls, icon, text) {
  return h('div', { class: 'msg ' + cls }, h('span', { class: 'icon', 'aria-hidden': 'true' }, icon), h('span', {}, linkify(text.trim())))
}
function scrollDown () { const log = document.getElementById('job-log'); log.scrollTop = log.scrollHeight }
function send (payload) { return api(`/api/jobs/${job.id}/input`, { method: 'POST', body: payload }).catch(() => {}) }
function handle (ev) {
  const log = document.getElementById('job-log')
  if (ev.t === 'raw') { terminal().write(Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0))); return }
  if (ev.t === 'exit') {
    job.done = true
    job.es.close()
    log.querySelectorAll('.skip-box').forEach((b) => b.remove())
    log.querySelectorAll('.ask-box input, .ask-box button').forEach((el) => { el.disabled = true })
    log.append(h('div', { class: 'done' + (ev.code ? ' failed' : '') }, ev.code ? 'That didn’t work (see above).' : 'Done.'))
    scrollDown()
    document.getElementById('job-cancel').hidden = true
    refresh()
    if (!ev.code && job.onDone) job.onDone()
    return
  }
  const e = ev.event
  const text = e.text || ''
  // a wait's "skip" button only means something until cage asks or does something else
  if (['prompt', 'confirm', 'skip', 'step'].includes(e.t)) log.querySelectorAll('.skip-box').forEach((b) => b.remove())
  switch (e.t) {
    case 'say': log.append(msg('say', '', text)); break
    case 'ok': log.append(msg('ok', '✓', text)); break
    case 'warn': log.append(msg('warn', '!', text)); break
    case 'bad': log.append(msg('bad', '✗', text)); break
    case 'hint': log.append(msg('hint', '→', text)); break
    case 'step': log.append(h('div', { class: 'msg step' }, h('span', {}, text), h('span', { class: 'detail' }, e.detail || ''))); break
    case 'text': log.append(h('div', { class: 'msg text' }, h('span', { class: 'icon' }), h('pre', {}, linkify(text)))); break
    case 'qr': {
      const q = qrcode(0, 'M')
      q.addData(text)
      q.make()
      log.append(h('div', { class: 'qr', title: text }, h('img', { src: q.createDataURL(6, 2), alt: 'QR code for ' + text })))
      break
    }
    case 'prompt': log.append(askBox(text, !!e.secret)); break
    case 'confirm': log.append(confirmBox(text, e.default === 'y')); break
    case 'skip': { // cage is waiting; this ends the wait (as Enter would)
      const b = h('div', { class: 'ask-box skip-box' }, h('button', { type: 'button', class: 'ghost', onclick: () => { send({ text: '' }); b.remove() } }, text))
      log.append(b)
      break
    }
    default: log.append(msg('say', '', text))
  }
  scrollDown()
}
function askBox (question, secret) {
  log().append(msg('ask', '?', question.replace(/\s+$/, '')))
  const input = h('input', { type: secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': question })
  const box = h('form', { class: 'ask-box' }, input, h('button', { type: 'submit' }, 'Send'))
  box.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const v = input.value
    send({ text: v })
    box.replaceWith(h('div', { class: 'answered' }, secret ? (v ? '•'.repeat(Math.min(v.length, 12)) : '(nothing)') : (v || '(nothing)')))
  })
  setTimeout(() => input.focus(), 30)
  return box
}
function confirmBox (question, yesDefault) {
  log().append(msg('ask', '?', question))
  const answer = (v, label) => () => { send({ text: v }); box.replaceWith(h('div', { class: 'answered' }, label)) }
  const yes = h('button', { type: 'button', class: yesDefault ? '' : 'ghost', onclick: answer('y', 'Yes') }, 'Yes')
  const no = h('button', { type: 'button', class: yesDefault ? 'ghost' : '', onclick: answer('n', 'No') }, 'No')
  const box = h('div', { class: 'ask-box' }, yes, no)
  setTimeout(() => (yesDefault ? yes : no).focus(), 30)
  return box
}
function log () { return document.getElementById('job-log') }
function terminal () {
  if (job.term) return job.term
  const el = document.getElementById('job-term')
  el.hidden = false
  const term = new Terminal({ fontSize: 13, convertEol: false, cursorBlink: true, theme: { background: '#111111' } })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(el)
  const resize = () => { try { fit.fit(); api(`/api/jobs/${job.id}/resize`, { method: 'POST', body: { cols: term.cols, rows: term.rows } }).catch(() => {}) } catch (e) {} }
  setTimeout(resize, 20)
  window.addEventListener('resize', resize)
  term.onData((d) => send({ raw: btoa(String.fromCharCode(...new TextEncoder().encode(d))) }))
  term.focus()
  job.term = term
  return term
}
document.getElementById('job-cancel').addEventListener('click', () => { if (job && !job.done) api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {}) })
dlg.addEventListener('close', () => {
  if (job && !job.done) api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {})
  if (job && job.es) job.es.close()
  if (job && job.term) job.term.dispose()
  job = null
  document.getElementById('job-cancel').hidden = false
  refresh()
})

// --- pages ------------------------------------------------------------------------------------------------------
function agentsOn () { return STATE.agents.filter((a) => a.enabled) }
function agentPicker (name) { // checkboxes for the agents, all ticked
  return h('span', { class: 'row' }, agentsOn().map((a) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, value: a.name, checked: true }), a.name)))
}
function picked (form, name) {
  const all = [...form.querySelectorAll(`input[name=${name}]`)]
  const on = all.filter((i) => i.checked).map((i) => i.value)
  return on.length === all.length ? [] : on
}
function head (title, sub, ...right) { return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), h('div', { class: 'row' }, right)) }
function btn (label, onclick, cls) { return h('button', { type: 'button', class: cls || '', onclick }, label) }

function pageHome () {
  const S = STATE
  if (!S.configured) {
    return h('section', { class: 'card center' },
      h('img', { src: 'logo.svg', alt: '', width: 120, height: 120 }),
      h('h1', {}, 'Your AI agents, each in its own little cage'),
      h('p', { class: 'muted' }, 'Claude Code, Codex, Cursor and Antigravity on your own subscriptions, each in a private VM, reachable from Telegram, Slack, Discord or WhatsApp. Setup takes about five minutes.'),
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '16px' } },
        btn('Set up cage', () => runJob(['onboard'], 'Setting up cage'))),
      restoreCard())
  }
  const alerts = h('div', { class: 'alerts' })
  if (S.events.unseen > 0) alerts.append(h('div', { class: 'alert bad' }, h('span', { class: 'grow' }, `${S.events.unseen} thing${S.events.unseen === 1 ? '' : 's'} blocked since you last looked`), btn('Review', () => go('security'), 'small')))
  if (S.memory.inbox > 0) alerts.append(h('div', { class: 'alert' }, h('span', { class: 'grow' }, `Your agents want to remember ${S.memory.inbox} new thing${S.memory.inbox === 1 ? '' : 's'}`), btn('Review', () => runJob(['memory'], 'What your agents want to remember'), 'small')))
  for (const c of S.connectors.filter((c) => c.broken)) alerts.append(h('div', { class: 'alert bad' }, h('span', { class: 'grow' }, `${c.name} needs you to sign in again`), btn('Sign in', () => runJob(['connect', 'add', c.name], 'Sign in to ' + c.name), 'small')))
  if (newer(LATEST, S.version)) alerts.append(h('div', { class: 'alert' }, h('span', { class: 'grow' }, `cage ${LATEST} is out (you have ${S.version})`), btn('Update', () => runJob(['update'], 'Updating cage'), 'small')))

  const cards = S.agents.slice().sort((a, b) => b.enabled - a.enabled).map((a) => {
    const actions = []
    if (!a.enabled || !a.reachable) actions.push(btn(a.enabled ? 'Connect a chat' : 'Add ' + a.label, () => runJob(['setup', a.name], 'Set up ' + a.label)))
    else if (a.state === 'none' || a.state === 'asleep') actions.push(btn('Wake up', () => runJob(['up', a.name], 'Waking ' + a.label)))
    else if (a.state === 'login') actions.push(btn('Sign in', () => runJob(['login', a.name], 'Sign ' + a.label + ' in to ' + a.plan)))
    if (a.enabled && a.reachable && ['ready', 'login', 'installing', 'stuck'].includes(a.state)) {
      if (a.state === 'ready') actions.push(btn('Restart', () => runJob(['up', a.name], 'Restarting ' + a.label), 'ghost'))
      actions.push(btn('Logs', () => runJob(['logs', a.name], a.label + ': what its VM is doing'), 'ghost'))
      actions.push(btn('Terminal', () => runJob(['shell', a.name], 'Inside ' + a.label + '’s cage'), 'ghost'))
      actions.push(btn('Sleep', () => runJob(['down', a.name], 'Putting ' + a.label + ' to sleep'), 'ghost'))
    }
    const chips = [
      ['Telegram', a.chats.telegram], ['Slack', a.chats.slack], ['Discord', a.chats.discord], ['WhatsApp', !!a.chats.whatsapp]
    ].filter(([, on]) => on).map(([n]) => h('span', { class: 'chip on' }, n))
    if (a.mask) chips.push(h('span', { class: 'chip on' }, 'privacy mask'))
    if (a.fallback) chips.push(h('span', { class: 'chip on' }, 'stand-in: ' + a.fallback))
    return h('article', { class: 'card agent' + (a.enabled ? '' : ' off'), style: { '--c': AGENT_COLORS[a.name] } },
      h('div', { class: 'who' }, h('img', { src: a.name + '.svg', alt: '' }),
        h('div', {}, h('div', { class: 'name' }, a.label),
          h('div', { class: 'state ' + a.state }, face(a.enabled ? a.state : 'none', a.name), ' ', a.enabled ? STATE_LABEL[a.state] : a.plan))),
      a.bot ? h('div', { class: 'small', style: { marginTop: '8px' } }, h('a', { href: 'https://t.me/' + a.bot, target: '_blank', rel: 'noopener noreferrer' }, '@' + a.bot)) : null,
      chips.length ? h('div', { class: 'chips' }, chips) : null,
      h('div', { class: 'actions' }, actions))
  })
  const q = h('input', { type: 'text', placeholder: 'Ask all your awake agents something…', 'aria-label': 'Question for all your agents' })
  const ask = h('form', { class: 'ask' }, q, h('button', { type: 'submit' }, 'Ask all'))
  ask.addEventListener('submit', (e) => { e.preventDefault(); if (q.value.trim()) runJob(['ask', q.value.trim()], 'Asking your agents') })
  return h('div', {}, head('Your agents', 'Each one lives in its own microVM, signed in to your own subscription.',
    btn('Wake everyone', () => runJob(['up'], 'Waking your agents'), 'ghost')),
  alerts.childElementCount ? alerts : null,
  h('div', { class: 'grid' }, cards),
  h('section', { class: 'card' }, h('h2', {}, 'Ask all of them'), ask,
    h('p', { class: 'small muted', style: { marginTop: '8px' } }, S.settings.ask_all === 'on' ? 'In any chat, start a message with /all (or @all in Slack) to do the same there.' : 'Turn on /all in Settings to do this from your chats too.')))
}

function restoreCard () { // moving to a new computer: put a backup back before anything else
  const file = h('input', { type: 'text', placeholder: '/mnt/c/Users/you/Documents/cage backups/cage-….cagebackup', style: { flex: 1 } })
  const form = h('form', { class: 'row', style: { marginTop: '8px' } }, file, h('button', { type: 'submit', class: 'ghost' }, 'Restore'))
  form.addEventListener('submit', (e) => { e.preventDefault(); if (file.value.trim()) runJob(['restore', file.value.trim()], 'Restoring your backup') })
  return h('div', { style: { marginTop: '28px', textAlign: 'left' } },
    h('h2', {}, 'Moving from another computer?'),
    h('p', { class: 'small muted' }, 'Restore a cage backup instead: your settings, keys, sign-ins and each agent’s login and files.'),
    STATE.backups.files.length ? h('ul', { class: 'list' }, STATE.backups.files.map((b) => h('li', {}, h('span', { class: 'grow' }, b.name, ' ', h('span', { class: 'muted small' }, ago(b.at))),
      btn('Restore', () => runJob(['restore', b.path], 'Restoring ' + b.name), 'small')))) : null,
    form)
}

function pageChats () {
  const rows = agentsOn().map((a) => {
    const c = a.chats
    const item = (name, on, add, rm, extra) => h('div', { class: 'row', style: { marginTop: '6px' } },
      h('span', { class: 'chip' + (on ? ' on' : ''), style: { '--c': AGENT_COLORS[a.name] } }, name + (on ? ' ✓' : '')),
      on ? (rm ? btn('Remove', rm, 'ghost small') : null) : btn('Add', add, 'small'), extra || null)
    return h('li', {}, h('div', { class: 'grow' }, h('b', {}, a.label),
      item('Telegram', c.telegram, () => runJob(['setup', a.name], 'Telegram for ' + a.label), null, c.telegram ? btn('Change', () => runJob(['setup', a.name], 'Telegram for ' + a.label), 'ghost small') : null),
      item('Slack', c.slack, () => runJob(['chat', 'add', 'slack', a.name], 'Slack for ' + a.label), () => runJob(['chat', 'rm', 'slack', a.name], 'Remove Slack')),
      item('Discord', c.discord, () => runJob(['chat', 'add', 'discord', a.name], 'Discord for ' + a.label), () => runJob(['chat', 'rm', 'discord', a.name], 'Remove Discord')),
      item('WhatsApp', !!c.whatsapp, () => runJob(['chat', 'add', 'whatsapp', a.name], 'WhatsApp for ' + a.label), () => runJob(['chat', 'rm', 'whatsapp', a.name], 'Remove WhatsApp'),
        c.whatsapp ? btn('Link again', () => runJob(['chat', 'link', 'whatsapp', a.name], 'Link WhatsApp'), 'ghost small') : null)))
  })
  return h('div', {}, head('Chats', 'Where you talk to your agents. Only you can, unless you let others in.'),
    h('section', { class: 'card' }, rows.length ? h('ul', { class: 'list' }, rows) : h('p', { class: 'empty' }, 'Set up cage first.')))
}

function pageApps () {
  const S = STATE
  const have = new Set(S.connectors.map((c) => c.name))
  const list = S.connectors.map((c) => h('li', {},
    h('div', { class: 'grow' }, h('b', {}, c.name), ' ', h('span', { class: 'muted small' }, c.title || c.url),
      h('div', { class: 'small muted' }, 'for ' + (c.agents === 'all' ? 'all agents' : c.agents), c.signin ? ' · signed in with your browser' : '', c.broken ? ' · needs you to sign in again' : '')),
    c.broken ? btn('Sign in', () => runJob(['connect', 'add', c.name], 'Sign in to ' + c.name), 'small') : null,
    btn('Remove', () => runJob(['connect', 'rm', c.name], 'Remove ' + c.name), 'ghost small')))
  const catalog = S.catalog.filter((c) => !have.has(c.name)).map((c) => {
    const f = h('form', { class: 'card' }, h('b', {}, c.name), h('p', { class: 'small muted' }, c.title), agentPicker('ag-' + c.name), h('div', { style: { marginTop: '10px' } }, h('button', { type: 'submit' }, 'Connect')))
    f.addEventListener('submit', (e) => { e.preventDefault(); runJob(['connect', 'add', c.name, ...picked(f, 'ag-' + c.name)], 'Connect ' + c.name) })
    return f
  })
  const name = h('input', { type: 'text', placeholder: 'name, e.g. crm', pattern: '[a-z][a-z0-9-]*', required: true })
  const url = h('input', { type: 'text', placeholder: 'https://…/mcp', required: true, style: { flex: 1 } })
  const custom = h('form', { class: 'card' }, h('h2', {}, 'Any other app'), h('p', { class: 'small muted' }, 'Anything with a remote MCP server address. cage asks for its key, or signs you in with your browser.'),
    h('div', { class: 'row' }, name, url), h('div', { style: { margin: '8px 0' } }, agentPicker('ag-custom')), h('button', { type: 'submit' }, 'Connect'))
  custom.addEventListener('submit', (e) => { e.preventDefault(); runJob(['connect', 'add', name.value.trim(), url.value.trim(), ...picked(custom, 'ag-custom')], 'Connect ' + name.value) })
  return h('div', {}, head('Apps', 'Your email, calendar, GitHub and more, as tools your agents can use. Keys stay on this computer.'),
    h('section', { class: 'card' }, h('h2', {}, 'Connected'), list.length ? h('ul', { class: 'list' }, list) : h('p', { class: 'empty' }, 'Nothing yet.')),
    catalog.length ? h('h3', {}, 'Add one') : null, h('div', { class: 'grid' }, catalog), custom)
}

function pageSignins () {
  const S = STATE
  const pw = S.passwords.map((p) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, p.site), ' ', h('span', { class: 'muted' }, p.user),
    h('div', { class: 'small muted' }, 'for ' + (p.agents === 'all' ? 'all agents' : p.agents))),
  btn('Remove', () => runJob(['password', 'rm', p.site], 'Remove ' + p.site), 'ghost small')))
  const site = h('input', { type: 'text', placeholder: 'example.com', required: true })
  const pwForm = h('form', {}, h('div', { class: 'row' }, site, agentPicker('ag-pw'), h('button', { type: 'submit' }, 'Add a sign-in')))
  pwForm.addEventListener('submit', (e) => { e.preventDefault(); runJob(['password', 'add', site.value.trim(), ...picked(pwForm, 'ag-pw')], 'A sign-in for ' + site.value) })
  const keys = S.secrets.map((s) => h('li', {}, h('div', { class: 'grow' }, h('b', { class: 'mono' }, s.name), ' ', h('span', { class: 'muted small' }, s.hosts),
    h('div', { class: 'small muted' }, 'for ' + (s.agents === 'all' ? 'all agents' : s.agents), s.for ? ` · used by ${s.for}` : '')),
  s.for ? null : btn('Remove', () => runJob(['secret', 'rm', s.name], 'Remove ' + s.name), 'ghost small')))
  const kname = h('input', { type: 'text', placeholder: 'GITHUB_TOKEN', pattern: '[A-Z][A-Z0-9_]+', required: true, class: 'mono' })
  const khosts = h('input', { type: 'text', placeholder: 'api.github.com', required: true })
  const kForm = h('form', {}, h('div', { class: 'row' }, kname, khosts, agentPicker('ag-key'), h('button', { type: 'submit' }, 'Add a key')))
  kForm.addEventListener('submit', (e) => { e.preventDefault(); runJob(['secret', 'add', kname.value.trim(), khosts.value.trim(), ...picked(kForm, 'ag-key')], 'Add ' + kname.value) })
  return h('div', {}, head('Sign-ins & keys', 'Your agents use these without ever seeing them: their VMs only get placeholders, swapped for the real thing on the way to the right site.'),
    h('section', { class: 'card' }, h('h2', {}, 'Website sign-ins'), pw.length ? h('ul', { class: 'list' }, pw) : h('p', { class: 'empty' }, 'None yet.'), pwForm),
    h('section', { class: 'card' }, h('h2', {}, 'API keys'), keys.length ? h('ul', { class: 'list' }, keys) : h('p', { class: 'empty' }, 'None yet.'), kForm))
}

function pageMemory () {
  const S = STATE
  const ta = h('textarea', { 'aria-label': 'About you', placeholder: 'Your name, what you do, how you like answers…' })
  const status = h('span', { class: 'muted small' })
  api('/api/memory/about').then((d) => { ta.value = d.text }).catch(() => {})
  const save = btn('Save', async () => {
    try { await api('/api/memory/about', { method: 'PUT', body: { text: ta.value } }); status.textContent = 'Saved. Your agents see it the next time they wake (or after a review below).' } catch (e) { status.textContent = e.message }
  })
  return h('div', {}, head('Memory', 'What all your agents know about you. They suggest new things; you decide what they keep.'),
    h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'New things to remember'),
      S.memory.inbox > 0 ? btn(`Review ${S.memory.inbox}`, () => runJob(['memory'], 'What your agents want to remember')) : h('span', { class: 'muted' }, 'Nothing new.'))),
    h('section', { class: 'card' }, h('h2', {}, 'About you'), ta, h('div', { class: 'row', style: { marginTop: '8px' } }, save, status)))
}

function pageSecurity () {
  const S = STATE
  if (S.events.unseen > 0) quietJob(['security'])   // you've seen them now
  const ev = S.events.recent.map((e) => {
    const when = `${e.count}× · ${ago(e.at)}`
    if (e.kind === 'secret') {
      return h('li', {}, h('span', { class: 'face', style: { '--c': 'var(--err)' } }, '‼'), h('div', { class: 'grow' },
        h('b', {}, `${e.agent} tried to send ${e.subject} to ${e.detail || 'an unknown host'}`), h('div', { class: 'small muted' }, 'Blocked; the real value never left. Usually a prompt injection: something it read told it to. ' + when)))
    }
    return h('li', {}, h('span', { class: 'face', style: { '--c': 'var(--amber)' } }, '!'), h('div', { class: 'grow' },
      h('b', {}, `${e.agent} couldn’t reach ${e.subject}`), h('div', { class: 'small muted' }, 'Strict network. ' + when)),
    btn('Allow', () => runJob(['allow', e.subject, e.agent], 'Allow ' + e.subject), 'ghost small'))
  })
  const strict = S.settings.network === 'strict'
  const seg = h('span', { class: 'seg' },
    h('button', { type: 'button', class: strict ? '' : 'on', onclick: () => strict && runJob(['network', 'open'], 'Open network') }, 'Open'),
    h('button', { type: 'button', class: strict ? 'on' : '', onclick: () => !strict && runJob(['network', 'strict'], 'Strict network') }, 'Strict'))
  const hosts = []
  for (const x of (S.settings.allow || '').split(/\s+/).filter(Boolean)) hosts.push([x, 'all'])
  for (const a of S.agents) for (const x of (a.allow || '').split(/\s+/).filter(Boolean)) hosts.push([x, a.name])
  const host = h('input', { type: 'text', placeholder: 'api.example.com or *.example.com', required: true })
  const add = h('form', { class: 'row' }, host, agentPicker('ag-allow'), h('button', { type: 'submit' }, 'Allow'))
  add.addEventListener('submit', (e) => { e.preventDefault(); runJob(['allow', host.value.trim(), ...picked(add, 'ag-allow')], 'Allow ' + host.value) })
  return h('div', {}, head('Security', 'What microsandbox blocked, and how far your agents can reach.'),
    h('section', { class: 'card' }, h('h2', {}, 'Blocked'), ev.length ? h('ul', { class: 'list' }, ev) : h('p', { class: 'empty' }, 'Nothing so far.')),
    h('section', { class: 'card' }, h('div', { class: 'setting' }, h('div', { class: 'what' }, h('b', {}, 'Network'),
      h('span', {}, strict ? 'Strict: each agent reaches only its own service, its chat apps, where it installs from, your apps and sites, and what you allow.' : 'Open: the public internet. Your computer, your network and cloud metadata are always blocked.')), seg),
    strict ? h('div', {}, h('h3', {}, 'Also allowed'), hosts.length ? h('ul', { class: 'list' }, hosts.map(([x, who]) => h('li', {}, h('span', { class: 'grow mono' }, x), h('span', { class: 'muted small' }, who === 'all' ? 'everyone' : who),
      btn('Remove', () => runJob(['allow', 'rm', x, who], 'Stop allowing ' + x), 'ghost small')))) : h('p', { class: 'empty' }, 'Nothing extra.'), add) : null))
}

function setting (title, sub, control) { return h('div', { class: 'setting' }, h('div', { class: 'what' }, h('b', {}, title), h('span', {}, sub)), control) }
function toggle (on, onChange) { return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => onChange(e.target.checked) }), on ? 'On' : 'Off') }

function pageSettings () {
  const S = STATE
  const st = S.settings
  const voice = h('span', { class: 'seg' }, ['off', 'local', 'groq'].map((v) => h('button', {
    type: 'button', class: st.voice === v ? 'on' : '', onclick: () => st.voice !== v && runJob(v === 'off' ? ['voice', 'off'] : ['voice', 'on', v], 'Voice notes')
  }, v === 'off' ? 'Off' : v === 'local' ? 'On this computer' : 'Groq')))
  const masks = h('span', { class: 'row' }, agentsOn().map((a) => h('label', { class: 'check' }, h('input', {
    type: 'checkbox', checked: a.mask, onchange: (e) => runJob(['mask', e.target.checked ? 'on' : 'off', a.name], 'Privacy mask for ' + a.label)
  }), a.name)))
  const term = h('input', { type: 'text', placeholder: 'a client, a project, a person', required: true })
  const termForm = h('form', { class: 'row' }, term, h('button', { type: 'submit', class: 'ghost' }, 'Mask this too'))
  termForm.addEventListener('submit', (e) => { e.preventDefault(); runJob(['mask', 'add', term.value.trim()], 'Privacy mask') })
  const tryIn = h('input', { type: 'text', placeholder: 'Try: email bob@acme.com about Acme', style: { flex: 1 } })
  const tryForm = h('form', { class: 'row' }, tryIn, h('button', { type: 'submit', class: 'ghost' }, 'Preview'))
  tryForm.addEventListener('submit', (e) => { e.preventDefault(); if (tryIn.value) runJob(['mask', 'try', tryIn.value], 'What the AI vendor would see') })
  const fallbacks = h('div', {}, agentsOn().map((a) => h('div', { class: 'row', style: { margin: '4px 0' } }, h('span', { style: { minWidth: '110px' } }, a.label + ' →'),
    h('select', { 'aria-label': 'Stand-in for ' + a.label, onchange: (e) => runJob(['fallback', a.name, e.target.value || 'off'], 'Stand-in for ' + a.label) },
      h('option', { value: '', selected: !a.fallback }, 'nobody'),
      agentsOn().filter((b) => b.name !== a.name).map((b) => h('option', { value: b.name, selected: a.fallback === b.name }, b.label))))))
  const backups = S.backups.files.map((b) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, b.name), h('div', { class: 'small muted' }, `${size(b.size)} · ${ago(b.at)}`)),
    btn('Restore', () => runJob(['restore', b.path], 'Restore ' + b.name), 'ghost small')))
  return h('div', {}, head('Settings', ''),
    h('section', { class: 'card' }, h('h2', {}, 'Privacy'),
      setting('Privacy mask', 'Emails, phone and card numbers, IBANs, keys and your own terms reach the AI vendor as tokens like [EMAIL_1], and come back as themselves. The agent can’t use a masked value itself.', masks),
      (S.mask_terms.length ? h('div', { class: 'chips' }, S.mask_terms.map((t) => h('span', { class: 'chip on' }, t, ' ', h('a', { href: '#', 'aria-label': 'Stop masking ' + t, onclick: (e) => { e.preventDefault(); runJob(['mask', 'rm', t], 'Privacy mask') } }, '×')))) : null),
      h('div', { style: { margin: '8px 0' } }, termForm), tryForm),
    h('section', { class: 'card' }, h('h2', {}, 'Chats'),
      setting('/all in chat', 'Start a message with /all (or @all) in any agent’s chat, and your other agents answer there too.', toggle(st.ask_all === 'on', (on) => runJob(['ask-all', on ? 'on' : 'off'], '/all in chat'))),
      setting('Voice notes', 'Send voice messages. “On this computer” turns them into text inside each agent’s VM (private, a 300 MB download once); Groq is faster, with your key.', voice),
      setting('Stand-ins', 'When an agent is out of quota, another one answers your message in its chat.', fallbacks)),
    h('section', { class: 'card' }, h('h2', {}, 'This computer'),
      setting('Wake up at login', 'Your agents start when you log in to this computer.', toggle(st.autostart, (on) => runJob(['autostart', on ? 'on' : 'off'], 'Autostart'))),
      setting('Updates', `You have cage ${S.version}${newer(LATEST, S.version) ? ', and ' + LATEST + ' is out' : ''}. Updating also gets the newest agent CLIs.`, btn('Update', () => runJob(['update'], 'Updating cage'))),
      setting('Check everything', 'This computer, the settings and the bots.', btn('Check', () => runJob(['doctor'], 'Checking'), 'ghost'))),
    h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Backups'), btn('Back up now', () => runJob(['backup'], 'Backing up'))),
      h('p', { class: 'small muted' }, `One encrypted file with your settings, keys, sign-ins and each agent’s login and files. Saved to ${S.backups.dir}. To move to a new computer, install cage there and restore it.`),
      backups.length ? h('ul', { class: 'list' }, backups) : h('p', { class: 'empty' }, 'No backups yet.')))
}

// --- routing ---------------------------------------------------------------------------------------------------
function go (p) { location.hash = p }
function render () {
  if (!STATE) return
  document.getElementById('nav').hidden = !STATE.configured
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page))
  const mem = document.getElementById('badge-memory')
  mem.hidden = !STATE.memory.inbox
  mem.textContent = STATE.memory.inbox
  const sec = document.getElementById('badge-security')
  sec.hidden = !STATE.events.unseen
  sec.textContent = STATE.events.unseen
  const ver = document.getElementById('version')
  ver.replaceChildren('cage ' + STATE.version)
  if (newer(LATEST, STATE.version)) ver.append(' · ', h('span', { class: 'update', onclick: () => runJob(['update'], 'Updating cage') }, LATEST + ' is out'))
  const fn = { home: pageHome, chats: pageChats, apps: pageApps, signins: pageSignins, memory: pageMemory, security: pageSecurity, settings: pageSettings }[STATE.configured ? page : 'home']
  const main = document.getElementById('main')
  // keep what you're typing: don't redraw a page while you're in one of its fields
  if (main.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && main.dataset.page === page) return
  main.dataset.page = page
  main.replaceChildren(fn())
}
function route () {
  const raw = location.hash.slice(1)
  if (/^[0-9a-f]{32,}$/.test(raw)) { // the token, from `cage ui`
    TOKEN = raw
    try { localStorage.setItem('cage-token', TOKEN) } catch (e) {}
    history.replaceState(null, '', location.pathname + '#home')
  }
  page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home'
  if (TOKEN) start()
  render()
}
let started = false
function start () {
  if (started) return
  started = true
  refresh()
  api('/api/update').then((d) => { LATEST = d.latest || ''; render() }).catch(() => {})
  setInterval(() => { if (!job && document.visibilityState === 'visible') refresh() }, 6000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !job) refresh() })
}

window.addEventListener('hashchange', route)
try { TOKEN = localStorage.getItem('cage-token') || '' } catch (e) {}
route()
if (!TOKEN) locked()
