// cage's web app. Everything it does is a cage command (a "job", see host/ui/server.py): the side panel shows cage's
// messages as a conversation, asks its questions with real input boxes, and opens a terminal view only when a
// vendor's own screen needs one (signing in, logs). What it shows comes from `cage _state`.
'use strict'

const AGENT = {
  claude: { color: 'var(--claude)', vendor: 'Anthropic' },
  codex: { color: 'var(--codex)', vendor: 'OpenAI' },
  cursor: { color: 'var(--cursor)', vendor: 'Cursor' },
  antigravity: { color: 'var(--antigravity)', vendor: 'Google' }
}
// what each state means, in words: a label, a tone (the dot's colour) and what to do about it
const STATUS = {
  ready: { label: 'Ready', tone: 'ok', help: 'Message it any time from your chat app.' },
  login: { label: 'Needs sign-in', tone: 'warn', help: 'Sign it in to your plan once, and it’s ready.' },
  installing: { label: 'Getting ready', tone: 'busy', help: 'Installing its tools. The first time takes a few minutes.' },
  asleep: { label: 'Asleep', tone: 'idle', help: 'Wake it up to message it. Its files and sign-in are kept.' },
  none: { label: 'Not started', tone: 'idle', help: 'Wake it up to start its private computer.' },
  stuck: { label: 'Stuck', tone: 'bad', help: 'Something went wrong. Restarting usually fixes it; the activity log says what happened.' },
  nochat: { label: 'No chat yet', tone: 'warn', help: 'Connect a chat app so you can message it.' },
  off: { label: 'Not set up', tone: 'off', help: '' }
}
const CHATS = [['telegram', 'Telegram'], ['slack', 'Slack'], ['discord', 'Discord'], ['whatsapp', 'WhatsApp']]
const PAGES = ['home', 'apps', 'signins', 'memory', 'security', 'settings']

let TOKEN = ''
let STATE = null
let SEEN = ''      // the state last drawn, to redraw only when something changed
let LATEST = ''
let page = 'home'
let ASK = null     // the last question you asked from Home, and its answers (kept in this tab only)

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
    else if (k === 'value') el.value = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return el
}
const SVG = 'http://www.w3.org/2000/svg'
function icon (name, cls) { // a Lucide icon (vendor/icons.js)
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'i' + (cls ? ' ' + cls : ''))
  svg.setAttribute('aria-hidden', 'true')
  for (const [tag, attrs] of (window.ICONS || {})[name] || []) {
    const el = document.createElementNS(SVG, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    svg.append(el)
  }
  return svg
}
const LINK_RE = /(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s<>"')\]]+)/g
function inline (text, plain) { // links (and, in answers, `code`, **bold**, [text](url)) made real
  const out = []
  let last = 0
  for (const m of text.matchAll(plain ? /(https?:\/\/[^\s<>"')\]]+)/g : LINK_RE)) {
    const t = m[0]
    if (m.index > last) out.push(text.slice(last, m.index))
    if (t[0] === '`') out.push(h('code', {}, t.slice(1, -1)))
    else if (t[0] === '*') out.push(h('strong', {}, t.slice(2, -2)))
    else if (t[0] === '[') {
      const [, label, url] = /^\[([^\]]+)\]\((.+)\)$/.exec(t)
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label))
    } else out.push(h('a', { href: t, target: '_blank', rel: 'noopener noreferrer' }, t))
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
function linkify (text) { return inline(text, true) }
function md (text) { // an agent's answer: paragraphs, lists, headings and code, the way chat apps show them
  const root = h('div', { class: 'md' })
  const lines = text.replace(/\r/g, '').split('\n')
  let para = []
  let list = null
  const flush = () => { if (para.length) root.append(h('p', {}, inline(para.join('\n')))); para = [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m
    if (/^\s*```/.test(line)) {
      flush(); list = null
      const buf = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i])
      root.append(h('pre', {}, h('code', {}, buf.join('\n'))))
    } else if ((m = /^#{1,6}\s+(.*)/.exec(line))) {
      flush(); list = null
      root.append(h('h4', {}, inline(m[1])))
    } else if ((m = /^\s*([-*•]|\d+[.)])\s+(.*)/.exec(line))) {
      flush()
      const tag = /\d/.test(m[1]) ? 'OL' : 'UL'
      if (!list || list.tagName !== tag) { list = h(tag.toLowerCase()); root.append(list) }
      list.append(h('li', {}, inline(m[2])))
    } else if (!line.trim()) {
      flush(); list = null
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.lastChild.append(' ', ...inline(line.trim()))
    } else {
      list = null
      para.push(line)
    }
  }
  flush()
  return root
}
function avatar (name, size) { return h('img', { class: 'avatar', src: name + '.svg', alt: '', width: size || 20, height: size || 20, style: { '--c': AGENT[name] && AGENT[name].color } }) }
function dot (tone) { return h('span', { class: 'dot ' + tone, 'aria-hidden': 'true' }) }
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
function plural (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')) }

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
  document.body.classList.add('is-locked')
  const main = document.getElementById('main')
  main.replaceChildren(document.getElementById('tpl-locked').content.cloneNode(true))
}
function watch (id, onEvent) { // a job's events, as they happen
  const es = new EventSource(`/api/jobs/${id}/events?from=0&token=${encodeURIComponent(TOKEN)}`)
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data)
    if (ev.t === 'exit') es.close()
    onEvent(ev)
  }
  return es
}

// --- jobs: a cage command, as a conversation in the side panel ----------------------------------------------------
const dlg = document.getElementById('job')
const logEl = document.getElementById('job-log')
let job = null
function setStatus (kind, text) {
  const s = document.getElementById('job-status')
  s.className = 'job-status ' + kind
  s.replaceChildren(kind === 'running' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(kind === 'done' ? 'circle-check' : 'circle-alert'), h('span', {}, text))
  dlg.classList.toggle('running', kind === 'running')
  document.getElementById('job-cancel').hidden = kind !== 'running'
  document.getElementById('job-close').hidden = kind === 'running'
}
async function runJob (args, title, onDone) {
  if (job && !job.done) return
  const termEl = document.getElementById('job-term')
  logEl.replaceChildren()
  termEl.hidden = true
  termEl.replaceChildren()
  dlg.classList.remove('wide')
  document.getElementById('job-title').textContent = title || ('cage ' + args.join(' '))
  setStatus('running', 'Working…')
  dlg.showModal()
  let id
  try { id = (await api('/api/jobs', { method: 'POST', body: { args } })).id } catch (e) {
    logEl.append(msg('bad', e.message)); setStatus('failed', 'That didn’t work'); return
  }
  job = { id, done: false, term: null, onDone }
  job.es = watch(id, handle)
}
async function quietJob (args) { // a command whose output nobody needs to see (marking events as seen)
  try { await api('/api/jobs', { method: 'POST', body: { args } }) } catch (e) {}
}
const MSG_ICON = { ok: 'check', warn: 'triangle-alert', bad: 'x', hint: 'info', ask: 'circle-question-mark' }
function sentence (text) { // cage's terminal style is lowercase; here, a message starts like a sentence ("cage" stays cage)
  const t = text.trim()
  return /^[a-z]+(?=[\s,;!?…]|$)/.test(t) && !/^cage\b/.test(t) ? t[0].toUpperCase() + t.slice(1) : t
}
function msg (kind, text) {
  return h('div', { class: 'msg ' + kind }, MSG_ICON[kind] ? h('span', { class: 'msg-icon' }, icon(MSG_ICON[kind])) : null, h('div', { class: 'msg-text' }, linkify(sentence(text))))
}
function scrollDown () { logEl.scrollTop = logEl.scrollHeight }
function send (payload) { return api(`/api/jobs/${job.id}/input`, { method: 'POST', body: payload }).catch(() => {}) }
function handle (ev) {
  if (!job) return
  if (ev.t === 'raw') { terminal().write(Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0))); return }
  if (ev.t === 'exit') {
    job.done = true
    logEl.querySelectorAll('.skip-box').forEach((b) => b.remove())
    logEl.querySelectorAll('.ask-box input, .ask-box button').forEach((el) => { el.disabled = true })
    setStatus(ev.code ? 'failed' : 'done', ev.code ? 'That didn’t work — see above' : 'Done.')
    scrollDown()
    document.getElementById('job-close').focus()
    refresh()
    if (!ev.code && job.onDone) job.onDone()
    return
  }
  const e = ev.event
  const text = e.text || ''
  // a wait's "skip" button only means something until cage asks or does something else
  if (['prompt', 'confirm', 'skip', 'step'].includes(e.t)) logEl.querySelectorAll('.skip-box').forEach((b) => b.remove())
  switch (e.t) {
    case 'say': case 'ok': case 'warn': case 'bad': case 'hint': logEl.append(msg(e.t, text)); break
    case 'step': logEl.append(h('div', { class: 'step' }, e.detail ? h('span', { class: 'step-n' }, 'Step ' + e.detail) : null, h('span', { class: 'step-title' }, text))); break
    case 'text': logEl.append(h('pre', { class: 'block' }, linkify(text))); break
    case 'qr': {
      const q = qrcode(0, 'M')
      q.addData(text)
      q.make()
      logEl.append(h('figure', { class: 'qr', title: text }, h('img', { src: q.createDataURL(6, 2), alt: 'QR code for ' + text }), h('figcaption', {}, 'Scan with your phone')))
      break
    }
    case 'prompt': logEl.append(askBox(text, !!e.secret)); break
    case 'confirm': logEl.append(confirmBox(text, e.default === 'y')); break
    case 'skip': { // cage is waiting; this ends the wait (as Enter would)
      const b = h('div', { class: 'ask-box skip-box' }, h('button', { type: 'button', class: 'btn', onclick: () => { send({ text: '' }); b.remove() } }, text))
      logEl.append(b)
      break
    }
    case 'asking': logEl.append(msg('say', 'Asking ' + e.agents.map(nameOf).join(', ') + '…')); break
    case 'answer': logEl.append(h('div', { class: 'msg answer' }, h('b', {}, nameOf(e.agent)), text ? md(text) : h('p', { class: 'muted' }, 'No answer.'))); break
    default: logEl.append(msg('say', text))
  }
  scrollDown()
}
function askBox (question, secret) {
  logEl.append(msg('ask', question.replace(/[\s:]+$/, '')))
  const input = h('input', { type: secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': question, placeholder: secret ? 'Hidden as you type' : 'Your answer' })
  const box = h('form', { class: 'ask-box' }, input, h('button', { type: 'submit', class: 'btn primary' }, 'Send'))
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
  logEl.append(msg('ask', question.replace(/[\s:]+$/, '')))
  const answer = (v, label) => () => { send({ text: v }); box.replaceWith(h('div', { class: 'answered' }, label)) }
  const yes = h('button', { type: 'button', class: 'btn' + (yesDefault ? ' primary' : ''), onclick: answer('y', 'Yes') }, 'Yes')
  const no = h('button', { type: 'button', class: 'btn' + (yesDefault ? '' : ' primary'), onclick: answer('n', 'No') }, 'No')
  const box = h('div', { class: 'ask-box' }, yes, no)
  setTimeout(() => (yesDefault ? yes : no).focus(), 30)
  return box
}
function terminal () {
  if (job.term) return job.term
  const el = document.getElementById('job-term')
  el.hidden = false
  dlg.classList.add('wide')
  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    convertEol: false,
    cursorBlink: true,
    theme: { background: '#0e0d14', foreground: '#e7e6ee', cursor: '#ffb833', selectionBackground: '#3b3561' }
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(el)
  const resize = () => { try { fit.fit(); api(`/api/jobs/${job.id}/resize`, { method: 'POST', body: { cols: term.cols, rows: term.rows } }).catch(() => {}) } catch (e) {} }
  setTimeout(resize, 220)   // after the panel has widened
  window.addEventListener('resize', resize)
  term.onData((d) => send({ raw: btoa(String.fromCharCode(...new TextEncoder().encode(d))) }))
  term.focus()
  job.term = term
  return term
}
document.getElementById('job-cancel').addEventListener('click', () => { if (job && !job.done) api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {}) })
document.getElementById('job-close').addEventListener('click', () => dlg.close())
document.getElementById('job-x').addEventListener('click', () => dlg.close())
dlg.addEventListener('close', () => {
  if (job && !job.done) api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {})
  if (job && job.es) job.es.close()
  if (job && job.term) job.term.dispose()
  job = null
  refresh()
})

// --- building blocks ---------------------------------------------------------------------------------------------
function nameOf (a) { const x = STATE && STATE.agents.find((y) => y.name === a); return x ? x.label : a }
function agentsOn () { return STATE.agents.filter((a) => a.enabled) }
function statusOf (a) {
  if (!a.enabled) return 'off'
  if (!a.reachable) return 'nochat'
  return STATUS[a.state] ? a.state : 'none'
}
function btn (label, onclick, cls, ic) { return h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick }, ic ? icon(ic) : null, label) }
function pageHead (title, sub, ...right) {
  return h('header', { class: 'page-head' }, h('div', { class: 'page-title' }, h('h1', {}, title), sub ? h('p', {}, sub) : null), right.length ? h('div', { class: 'row' }, right) : null)
}
function section (title, sub, ...kids) {
  const tools = kids.length && kids[0] && kids[0].classList && kids[0].classList.contains('section-tools') ? kids.shift() : null
  return h('section', { class: 'section' }, title ? h('div', { class: 'section-head' }, h('h2', {}, title), tools, sub ? h('p', {}, sub) : null) : null, kids)
}
function rows (items, empty) { return items.length ? h('ul', { class: 'list' }, items) : h('p', { class: 'empty' }, empty) }
function field (label, input, hint) { return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null) }
const PRETTY = { github: 'GitHub', gitlab: 'GitLab', zapier: 'Zapier', notion: 'Notion', atlassian: 'Atlassian', sentry: 'Sentry', linear: 'Linear', browser: 'Web browser', gmail: 'Gmail', slack: 'Slack', figma: 'Figma', stripe: 'Stripe', hubspot: 'HubSpot' }
function pretty (name) { return PRETTY[name] || name.charAt(0).toUpperCase() + name.slice(1) }
function monogram (name) { return h('span', { class: 'mono-tile', 'aria-hidden': 'true' }, name.slice(0, 1).toUpperCase()) }
function setting (title, sub, control, top) { return h('div', { class: 'setting' + (top ? ' top' : '') }, h('div', { class: 'what' }, h('b', {}, title), sub ? h('span', {}, sub) : null), h('div', { class: 'control' }, control)) }
function toggle (on, onChange, label) { // a switch, on a real checkbox
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: on, 'aria-label': label || null, onchange: (e) => onChange(e.target.checked) }), h('span', { class: 'track', 'aria-hidden': 'true' }))
}
function seg (options, current, onPick) {
  return h('div', { class: 'seg', role: 'group' }, options.map(([v, label]) =>
    h('button', { type: 'button', class: current === v ? 'on' : '', 'aria-pressed': current === v ? 'true' : 'false', onclick: () => current !== v && onPick(v) }, label)))
}
function scope (name) { // "for which agents": all of them, unless you open it and untick some
  const summary = h('summary', {}, 'All agents')
  const boxes = agentsOn().map((a) => h('label', { class: 'check' }, h('input', {
    type: 'checkbox', name, value: a.name, checked: true,
    onchange: () => {
      const on = boxes.filter((b) => b.firstChild.checked).map((b) => nameOf(b.firstChild.value))
      summary.textContent = on.length === boxes.length ? 'All agents' : on.length ? on.join(', ') : 'Nobody'
    }
  }), avatar(a.name, 16), a.label))
  return h('details', { class: 'scope' }, summary, h('div', { class: 'scope-menu' }, boxes))
}
function picked (form, name) {
  const all = [...form.querySelectorAll(`input[name=${name}]`)]
  const on = all.filter((i) => i.checked).map((i) => i.value)
  return on.length === all.length ? [] : on
}
function forWhom (agents) { return agents === 'all' ? 'All agents' : agents.split(/[ ,]+/).filter(Boolean).map(nameOf).join(', ') }

// --- Home: what needs you, ask your agents, and how each one is doing ----------------------------------------------
function attention () {
  const S = STATE
  const out = []
  const item = (tone, ic, text, action) => h('li', { class: 'attn ' + tone }, h('span', { class: 'attn-icon' }, icon(ic)), h('span', { class: 'grow' }, text), action)
  for (const a of agentsOn()) {
    const s = statusOf(a)
    if (s === 'login') out.push(item('warn', 'log-in', `${a.label} needs you to sign in to ${a.plan}`, btn('Sign in', () => runJob(['login', a.name], 'Sign ' + a.label + ' in'), 'sm')))
    if (s === 'stuck') out.push(item('bad', 'circle-alert', `${a.label} is stuck`, btn('Restart', () => runJob(['up', a.name], 'Restarting ' + a.label), 'sm')))
    if (s === 'nochat') out.push(item('warn', 'message-circle', `${a.label} has no chat app yet, so you can’t message it`, btn('Connect a chat', () => runJob(['setup', a.name], 'A chat for ' + a.label), 'sm')))
  }
  for (const c of S.connectors.filter((c) => c.broken)) out.push(item('bad', 'blocks', `${pretty(c.name)} needs you to sign in again`, btn('Sign in', () => runJob(['connect', 'add', c.name], 'Sign in to ' + pretty(c.name)), 'sm')))
  if (S.events.unseen > 0) out.push(item('bad', 'shield-alert', `cage blocked ${plural(S.events.unseen, 'thing')} since you last looked`, btn('Review', () => go('security'), 'sm')))
  if (S.memory.inbox > 0) out.push(item('info', 'brain', `Your agents want to remember ${plural(S.memory.inbox, 'new thing')}`, btn('Review', () => runJob(['memory'], 'What your agents want to remember'), 'sm')))
  if (newer(LATEST, S.version)) out.push(item('info', 'download', `cage ${LATEST} is available (you have ${S.version})`, btn('Update', () => runJob(['update'], 'Updating cage'), 'sm')))
  return out
}

function composer () {
  const awake = agentsOn().filter((a) => a.state === 'ready')
  const ta = h('textarea', { rows: 2, placeholder: awake.length ? 'Ask all your agents something…' : 'Wake an agent up to ask it something', 'aria-label': 'Question for your agents', 'data-keep': 'ask', disabled: !awake.length })
  const pills = agentsOn().map((a) => {
    const ready = a.state === 'ready'
    return h('label', { class: 'pill' + (ready ? '' : ' disabled'), title: ready ? '' : nameOf(a.name) + ' is ' + STATUS[statusOf(a)].label.toLowerCase() },
      h('input', { type: 'checkbox', name: 'ask-who', value: a.name, checked: ready, disabled: !ready }), avatar(a.name, 16), h('span', {}, a.label))
  })
  const sendBtn = h('button', { type: 'submit', class: 'send', 'aria-label': 'Ask', title: 'Ask (Enter)', disabled: !awake.length }, icon('arrow-up'))
  const form = h('form', { class: 'composer' }, ta, h('div', { class: 'composer-bar' }, h('div', { class: 'pills' }, pills), sendBtn))
  const submit = () => {
    const q = ta.value.trim()
    const who = [...form.querySelectorAll('input[name=ask-who]:checked')].map((i) => i.value)
    if (!q || !who.length || (ASK && !ASK.done)) return
    ta.value = ''
    ask(q, who)
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit() })
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() } })
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px' })
  return form
}
async function ask (q, who) { // cage ask, its answers side by side as each comes in
  ASK = { q, who, at: Date.now() / 1000, agents: who, answers: {}, notes: [], error: '', done: false }
  drawAnswers()
  try {
    const { id } = await api('/api/jobs', { method: 'POST', body: { args: ['ask', q, ...who] } })
    const mine = ASK
    watch(id, (ev) => {
      if (ASK !== mine) return
      if (ev.t === 'exit') { mine.done = true; if (ev.code && !mine.error) mine.error = 'Your agents couldn’t be asked.' } else if (ev.t === 'event') {
        const e = ev.event
        if (e.t === 'asking') mine.agents = e.agents
        else if (e.t === 'answer') mine.answers[e.agent] = e.text || ''
        else if (e.t === 'warn' || e.t === 'hint') mine.notes.push(e.text)
        else if (e.t === 'bad') mine.error = e.text
      }
      drawAnswers()
    })
  } catch (e) { ASK.error = e.message; ASK.done = true; drawAnswers() }
}
function answers () {
  if (!ASK) return h('div', { id: 'answers' })
  const cards = ASK.agents.map((a) => {
    const has = a in ASK.answers
    const text = ASK.answers[a] || ''
    const body = has ? (text ? md(text) : h('p', { class: 'muted' }, 'No answer. It may be signed out, busy, or out of quota.'))
      : ASK.done ? h('p', { class: 'muted' }, 'No answer.') : h('div', { class: 'skeleton' }, h('span'), h('span'), h('span'))
    return h('article', { class: 'answer-card' + (has ? '' : ' waiting'), style: { '--c': AGENT[a] && AGENT[a].color } },
      h('header', {}, avatar(a, 20), h('b', {}, nameOf(a)), h('span', { class: 'answer-state' }, has ? (text ? 'Answered' : 'No answer') : ASK.done ? '' : 'Thinking…'),
        has && text ? h('button', { type: 'button', class: 'icon-btn', title: 'Copy', 'aria-label': 'Copy ' + nameOf(a) + '’s answer', onclick: (e) => { navigator.clipboard.writeText(text).then(() => { e.currentTarget.replaceChildren(icon('check')) }).catch(() => {}) } }, icon('copy')) : null),
      body)
  })
  return h('div', { id: 'answers', class: 'answers' },
    h('div', { class: 'answers-q' }, h('span', { class: 'you' }, 'You asked'), h('p', {}, ASK.q),
      ASK.done ? btn('Clear', () => { ASK = null; drawAnswers() }, 'sm ghost') : h('span', { class: 'muted small' }, 'Up to 5 minutes')),
    ASK.error ? h('p', { class: 'note bad' }, icon('circle-alert'), ASK.error) : null,
    cards.length ? h('div', { class: 'answers-grid', style: { '--n': Math.min(cards.length, 3) } }, cards) : null,
    ASK.notes.map((n) => h('p', { class: 'note' }, icon('info'), n)))
}
function drawAnswers () { const el = document.getElementById('answers'); if (el) el.replaceWith(answers()) }

function agentRow (a) {
  const s = statusOf(a)
  const st = STATUS[s]
  const chats = CHATS.filter(([k]) => a.chats[k]).map(([, n]) => n)
  let action = null
  if (s === 'off') action = btn('Set up', () => runJob(['setup', a.name], 'Set up ' + a.label), 'sm')
  else if (s === 'nochat') action = btn('Connect a chat', () => runJob(['setup', a.name], 'A chat for ' + a.label), 'sm')
  else if (s === 'asleep' || s === 'none') action = btn('Wake up', () => runJob(['up', a.name], 'Waking ' + a.label), 'sm')
  else if (s === 'login') action = btn('Sign in', () => runJob(['login', a.name], 'Sign ' + a.label + ' in'), 'sm')
  else if (a.bot) action = h('a', { class: 'btn sm ghost', href: 'https://t.me/' + a.bot, target: '_blank', rel: 'noopener noreferrer', title: 'Open its Telegram chat' }, '@' + a.bot)
  return h('li', { class: 'agent' + (a.enabled ? '' : ' off'), style: { '--c': AGENT[a.name].color } },
    h('a', { class: 'agent-main', href: '#agent/' + a.name },
      avatar(a.name, 36),
      h('span', { class: 'agent-text' }, h('span', { class: 'agent-name' }, a.label),
        h('span', { class: 'agent-sub' }, h('span', { class: 'status ' + st.tone }, dot(st.tone), st.label),
          a.enabled ? (chats.length ? ' · ' + chats.join(', ') : '') : ' · uses ' + a.plan))),
    action, h('a', { class: 'chev', href: '#agent/' + a.name, 'aria-label': 'Open ' + a.label }, icon('chevron-right')))
}

function pageHome () {
  const S = STATE
  if (!S.configured) return pageWelcome()
  const todo = attention()
  const sleepy = agentsOn().filter((a) => a.reachable && ['asleep', 'none'].includes(a.state))
  return h('div', { class: 'page' },
    todo.length ? section('Needs you', '', h('ul', { class: 'list attn-list' }, todo)) : null,
    h('section', { class: 'section hero' }, h('div', { class: 'section-head' }, h('h2', {}, 'Ask your agents'),
      h('p', {}, 'Each awake agent answers on its own, side by side. When they agree, you can be fairly sure; when they don’t, that’s the part worth a closer look.')), composer(), answers()),
    section('Your agents', '', h('div', { class: 'section-tools' }, sleepy.length ? btn('Wake everyone', () => runJob(['up'], 'Waking your agents'), 'sm ghost', 'power') : null),
      h('ul', { class: 'list agents' }, S.agents.slice().sort((a, b) => b.enabled - a.enabled).map(agentRow)),
      h('p', { class: 'small muted foot' }, S.settings.ask_all === 'on' ? 'In any chat, start a message with /all to ask all of them from there too.' : 'Tip: turn on “Ask everyone from chat” in Settings to do this from your phone too.')))
}

function pageWelcome () {
  const stepsList = [
    ['Pick your agents', 'Claude Code, Codex, Cursor or Antigravity, on the plans you already pay for.'],
    ['Give each one a chat', 'A Telegram bot, Slack, Discord or WhatsApp. Only you can message it.'],
    ['Sign in once', 'Each agent signs in to your plan inside its own private computer.']
  ]
  return h('div', { class: 'page welcome' },
    h('div', { class: 'welcome-hero' },
      h('img', { src: 'logo.svg', alt: '', width: 88, height: 88 }),
      h('h1', {}, 'AI agents you can text, each in its own cage'),
      h('p', { class: 'lede' }, 'Every agent runs on its own sealed-off computer on this machine, so it can work freely without touching your files, passwords or network. You talk to it from the chat apps you already use.'),
      btn('Set up cage', () => runJob(['onboard'], 'Setting up cage'), 'primary lg'),
      h('p', { class: 'small muted' }, 'Takes about five minutes.')),
    h('ol', { class: 'steps' }, stepsList.map(([t, d], i) => h('li', {}, h('span', { class: 'step-num' }, String(i + 1)), h('b', {}, t), h('span', {}, d)))),
    restoreBox())
}
function restoreBox () { // moving to a new computer: put a backup back before anything else
  const file = h('input', { type: 'text', placeholder: '/mnt/c/Users/you/Documents/cage backups/cage-….cagebackup', 'data-keep': 'restore' })
  const form = h('form', { class: 'inline-form' }, field('Or the full path of a backup file', file), h('button', { type: 'submit', class: 'btn' }, 'Restore'))
  form.addEventListener('submit', (e) => { e.preventDefault(); if (file.value.trim()) runJob(['restore', file.value.trim()], 'Restoring your backup') })
  return h('details', { class: 'disclosure' }, h('summary', {}, icon('archive'), 'Moving from another computer? Restore a backup'),
    h('p', { class: 'small muted' }, 'Your settings, keys, sign-ins, and each agent’s login and files.'),
    STATE.backups.files.length ? rows(STATE.backups.files.map((b) => h('li', {}, h('span', { class: 'grow' }, b.name, ' ', h('span', { class: 'muted small' }, ago(b.at))),
      btn('Restore', () => runJob(['restore', b.path], 'Restoring ' + b.name), 'sm')))) : null,
    form)
}

// --- one agent ---------------------------------------------------------------------------------------------------
function pageAgent (name) {
  const a = STATE.agents.find((x) => x.name === name)
  if (!a) return h('div', { class: 'page' }, pageHead('No such agent', ''), btn('Back to Home', () => go('home')))
  const s = statusOf(a)
  const st = STATUS[s]
  const meta = AGENT[a.name]
  const headTitle = h('div', { class: 'agent-head', style: { '--c': meta.color } }, avatar(a.name, 56),
    h('div', {}, h('h1', {}, a.label), h('p', { class: 'status ' + st.tone }, dot(st.tone), st.label, h('span', { class: 'muted' }, ' · uses ' + a.plan))))
  if (!a.enabled) {
    return h('div', { class: 'page' }, h('header', { class: 'page-head' }, headTitle),
      h('div', { class: 'empty-state' }, icon('sparkles', 'lg'), h('h2', {}, 'Add ' + a.label),
        h('p', {}, `cage gives ${a.label} its own private computer, signs it in to your ${a.plan} plan and connects it to a chat app. About five minutes.`),
        btn('Set up ' + a.label, () => runJob(['setup', a.name], 'Set up ' + a.label), 'primary')))
  }
  let primary = null
  if (s === 'nochat') primary = btn('Connect a chat', () => runJob(['setup', a.name], 'A chat for ' + a.label), 'primary')
  else if (s === 'asleep' || s === 'none') primary = btn('Wake up', () => runJob(['up', a.name], 'Waking ' + a.label), 'primary', 'power')
  else if (s === 'login') primary = btn('Sign in', () => runJob(['login', a.name], 'Sign ' + a.label + ' in to ' + a.plan), 'primary', 'log-in')
  else if (s === 'stuck') primary = btn('Restart', () => runJob(['up', a.name], 'Restarting ' + a.label), 'primary', 'rotate-cw')

  const c = a.chats
  const chatRow = (key, label) => {
    const on = !!c[key]
    let detail = on ? 'Connected' : 'Not connected'
    let open = null
    const acts = []
    if (key === 'telegram') {
      if (on && a.bot) open = h('a', { class: 'btn sm ghost', href: 'https://t.me/' + a.bot, target: '_blank', rel: 'noopener noreferrer' }, '@' + a.bot, icon('external-link'))
      acts.push(btn(on ? 'Change' : 'Add', () => runJob(['setup', a.name], 'Telegram for ' + a.label), on ? 'sm ghost' : 'sm'))
    } else {
      if (key === 'whatsapp' && on) {
        detail = typeof c.whatsapp === 'string' ? 'Connected · ' + c.whatsapp : 'Connected'
        acts.push(btn('Link again', () => runJob(['chat', 'link', 'whatsapp', a.name], 'Link WhatsApp'), 'sm ghost'))
      }
      acts.push(on ? btn('Remove', () => runJob(['chat', 'rm', key, a.name], 'Remove ' + label), 'sm ghost danger')
        : btn('Add', () => runJob(['chat', 'add', key, a.name], label + ' for ' + a.label), 'sm'))
    }
    return h('li', {}, h('span', { class: 'chat-mark ' + key, 'aria-hidden': 'true' }, icon('message-circle')),
      h('span', { class: 'grow' }, h('b', {}, label), h('span', { class: 'sub' + (on ? ' on' : '') }, detail)), open, acts)
  }
  const others = agentsOn().filter((b) => b.name !== a.name)
  return h('div', { class: 'page' },
    h('header', { class: 'page-head' }, headTitle, primary ? h('div', { class: 'row' }, primary) : null),
    st.help && s !== 'ready' ? h('p', { class: 'callout ' + st.tone }, icon(st.tone === 'bad' ? 'circle-alert' : 'info'), st.help) : null,
    section('Where you talk to it', 'Only you can message it, unless you let others in.', h('ul', { class: 'list chats' }, CHATS.map(([k, n]) => chatRow(k, n)))),
    section('Preferences', '', h('div', { class: 'card' },
      setting('Privacy mask', `Emails, phone and card numbers, and your own words reach ${meta.vendor} as placeholders like [EMAIL_1], and come back as themselves.`,
        toggle(a.mask, (on) => runJob(['mask', on ? 'on' : 'off', a.name], 'Privacy mask for ' + a.label), 'Privacy mask for ' + a.label)),
      setting('When it hits its usage limit', 'Another agent answers your message in its chat instead.', others.length ? fallbackSelect(a, others) : h('span', { class: 'muted small' }, 'Add another agent first')))),
    section('Troubleshooting', 'You won’t usually need these.', h('div', { class: 'tools' },
      s === 'ready' || s === 'stuck' || s === 'login' || s === 'installing' ? [
        btn('Activity log', () => runJob(['logs', a.name], a.label + ': activity log'), '', 'scroll-text'),
        btn('Restart', () => runJob(['up', a.name], 'Restarting ' + a.label), '', 'rotate-cw'),
        btn('Terminal', () => runJob(['shell', a.name], 'Inside ' + a.label + '’s computer'), '', 'square-terminal'),
        btn('Put to sleep', () => runJob(['down', a.name], 'Putting ' + a.label + ' to sleep'), '', 'moon')
      ] : h('p', { class: 'muted small' }, 'Wake it up first.'))))
}
function fallbackSelect (a, others) {
  return h('select', { 'aria-label': 'Stand-in for ' + a.label, onchange: (e) => runJob(['fallback', a.name, e.target.value || 'off'], 'Stand-in for ' + a.label) },
    h('option', { value: '', selected: !a.fallback }, 'Nobody'),
    others.map((b) => h('option', { value: b.name, selected: a.fallback === b.name }, b.label)))
}

// --- what they can use -------------------------------------------------------------------------------------------
function pageApps () {
  const S = STATE
  const have = new Set(S.connectors.map((c) => c.name))
  const list = S.connectors.map((c) => h('li', {}, monogram(c.name),
    h('span', { class: 'grow' }, h('b', {}, pretty(c.name)), h('span', { class: 'sub' }, [c.title && c.title !== pretty(c.name) ? c.title : '', forWhom(c.agents), c.signin ? 'signed in with your browser' : ''].filter(Boolean).join(' · ')),
      c.broken ? h('span', { class: 'sub bad' }, 'Needs you to sign in again') : null),
    c.broken ? btn('Sign in', () => runJob(['connect', 'add', c.name], 'Sign in to ' + pretty(c.name)), 'sm primary') : null,
    btn('Remove', () => runJob(['connect', 'rm', c.name], 'Remove ' + pretty(c.name)), 'sm ghost danger')))
  const catalog = S.catalog.filter((c) => !have.has(c.name)).map((c) => {
    const f = h('form', { class: 'tile' }, h('div', { class: 'tile-top' }, monogram(c.name), h('b', {}, pretty(c.name))), h('p', {}, sentence(c.title.replace(/^[^:]{1,24}:\s*/, ''))),
      h('div', { class: 'tile-foot' }, scope('ag-' + c.name), h('button', { type: 'submit', class: 'btn sm' }, 'Connect')))
    f.addEventListener('submit', (e) => { e.preventDefault(); runJob(['connect', 'add', c.name, ...picked(f, 'ag-' + c.name)], 'Connect ' + pretty(c.name)) })
    return f
  })
  const name = h('input', { type: 'text', placeholder: 'crm', pattern: '[a-z][a-z0-9-]*', required: true, 'data-keep': 'app-name' })
  const url = h('input', { type: 'text', placeholder: 'https://example.com/mcp', required: true, 'data-keep': 'app-url' })
  const custom = h('form', { class: 'stack' }, h('div', { class: 'fields' }, field('Name', name, 'Lowercase, like crm'), field('Server address', url, 'Its remote MCP URL')),
    h('div', { class: 'row' }, scope('ag-custom'), h('button', { type: 'submit', class: 'btn' }, 'Connect')))
  custom.addEventListener('submit', (e) => { e.preventDefault(); runJob(['connect', 'add', name.value.trim(), url.value.trim(), ...picked(custom, 'ag-custom')], 'Connect ' + name.value) })
  return h('div', { class: 'page' }, pageHead('Apps', 'Your email, calendar, GitHub and more, as tools your agents can use. Keys stay on this computer.'),
    section('Connected', '', h('div', { class: 'card flush' }, rows(list, 'No apps yet. Connect one below.'))),
    catalog.length ? section('Add an app', '', h('div', { class: 'tiles' }, catalog)) : null,
    h('details', { class: 'disclosure' }, h('summary', {}, icon('plus'), 'Another app'), h('p', { class: 'small muted' }, 'Anything with a remote MCP server. cage asks for its key, or signs you in with your browser.'), custom))
}

function pageSignins () {
  const S = STATE
  const pw = S.passwords.map((p) => h('li', {}, h('span', { class: 'chat-mark' }, icon('globe')),
    h('span', { class: 'grow' }, h('b', {}, p.site), h('span', { class: 'sub' }, p.user + ' · ' + forWhom(p.agents))),
    btn('Remove', () => runJob(['password', 'rm', p.site], 'Remove ' + p.site), 'sm ghost danger')))
  const site = h('input', { type: 'text', placeholder: 'example.com', required: true, 'data-keep': 'pw-site' })
  const pwForm = h('form', { class: 'add-row' }, field('Website', site), scope('ag-pw'), h('button', { type: 'submit', class: 'btn' }, 'Add a sign-in'))
  pwForm.addEventListener('submit', (e) => { e.preventDefault(); runJob(['password', 'add', site.value.trim(), ...picked(pwForm, 'ag-pw')], 'A sign-in for ' + site.value) })
  const keys = S.secrets.map((s) => h('li', {}, h('span', { class: 'chat-mark' }, icon('key-round')),
    h('span', { class: 'grow' }, h('b', { class: 'mono' }, s.name), h('span', { class: 'sub' }, [s.hosts, forWhom(s.agents), s.for ? 'used by ' + s.for : ''].filter(Boolean).join(' · '))),
    s.for ? null : btn('Remove', () => runJob(['secret', 'rm', s.name], 'Remove ' + s.name), 'sm ghost danger')))
  const kname = h('input', { type: 'text', placeholder: 'GITHUB_TOKEN', pattern: '[A-Z][A-Z0-9_]+', required: true, class: 'mono', 'data-keep': 'key-name' })
  const khosts = h('input', { type: 'text', placeholder: 'api.github.com', required: true, 'data-keep': 'key-hosts' })
  const kForm = h('form', { class: 'add-row' }, field('Name', kname), field('Only sent to', khosts), scope('ag-key'), h('button', { type: 'submit', class: 'btn' }, 'Add a key'))
  kForm.addEventListener('submit', (e) => { e.preventDefault(); runJob(['secret', 'add', kname.value.trim(), khosts.value.trim(), ...picked(kForm, 'ag-key')], 'Add ' + kname.value) })
  return h('div', { class: 'page' }, pageHead('Sign-ins & keys', 'Your agents use these without ever seeing them. Their computers only get placeholders, swapped for the real thing on the way to the right website.'),
    section('Website sign-ins', 'A username and password an agent can log in with.', h('div', { class: 'card flush' }, rows(pw, 'None yet.'), pwForm)),
    section('API keys', 'For services your agents call directly. You type the key in the next step; it’s never shown again.', h('div', { class: 'card flush' }, rows(keys, 'None yet.'), kForm)))
}

function pageMemory () {
  const S = STATE
  const ta = h('textarea', { 'aria-label': 'About you', placeholder: 'Your name, what you do, how you like answers…', rows: 10 })
  const status = h('span', { class: 'muted small' })
  api('/api/memory/about').then((d) => { ta.value = d.text }).catch(() => {})
  const save = btn('Save', async () => {
    try { await api('/api/memory/about', { method: 'PUT', body: { text: ta.value } }); status.textContent = 'Saved. Your agents see it the next time they wake up.' } catch (e) { status.textContent = e.message }
  }, 'primary')
  return h('div', { class: 'page' }, pageHead('Memory', 'What all your agents know about you. They suggest new things; nothing is kept until you say so.'),
    section('Suggestions', '', h('div', { class: 'card row spread' },
      h('span', {}, S.memory.inbox > 0 ? `Your agents want to remember ${plural(S.memory.inbox, 'new thing')}.` : 'Nothing new to review.'),
      S.memory.inbox > 0 ? btn('Review', () => runJob(['memory'], 'What your agents want to remember'), 'primary') : null)),
    section('About you', 'Every agent reads this. Write it like a note to a new colleague.', h('div', { class: 'stack' }, ta, h('div', { class: 'row' }, save, status))))
}

function pageSecurity () {
  const S = STATE
  if (S.events.unseen > 0) quietJob(['security'])   // you've seen them now
  const ev = S.events.recent.map((e) => {
    const when = `${e.count > 1 ? e.count + ' times · ' : ''}${ago(e.at)}`
    if (e.kind === 'secret') {
      return h('li', {}, h('span', { class: 'chat-mark bad' }, icon('shield-alert')), h('span', { class: 'grow' },
        h('b', {}, `${nameOf(e.agent)} tried to send ${e.subject} to ${e.detail || 'an unknown website'}`),
        h('span', { class: 'sub' }, 'Blocked: the real value never left. Usually something it read told it to (a prompt injection). ' + when)))
    }
    return h('li', {}, h('span', { class: 'chat-mark warn' }, icon('globe')), h('span', { class: 'grow' },
      h('b', {}, `${nameOf(e.agent)} couldn’t reach ${e.subject}`), h('span', { class: 'sub' }, 'Internet access is locked down. ' + when)),
    btn('Allow', () => runJob(['allow', e.subject, e.agent], 'Allow ' + e.subject), 'sm'))
  })
  const strict = S.settings.network === 'strict'
  const hosts = []
  for (const x of (S.settings.allow || '').split(/\s+/).filter(Boolean)) hosts.push([x, 'all'])
  for (const a of S.agents) for (const x of (a.allow || '').split(/\s+/).filter(Boolean)) hosts.push([x, a.name])
  const host = h('input', { type: 'text', placeholder: 'api.example.com or *.example.com', required: true, 'data-keep': 'allow-host' })
  const add = h('form', { class: 'add-row' }, field('Website', host), scope('ag-allow'), h('button', { type: 'submit', class: 'btn' }, 'Allow'))
  add.addEventListener('submit', (e) => { e.preventDefault(); runJob(['allow', host.value.trim(), ...picked(add, 'ag-allow')], 'Allow ' + host.value) })
  return h('div', { class: 'page' }, pageHead('Security', 'What cage stopped, and how much of the internet your agents can reach.'),
    section('Internet access', '', h('div', { class: 'card' },
      setting(strict ? 'Locked down' : 'Open to the internet', strict
        ? 'Each agent reaches only its own AI service, its chat apps, where it installs from, your apps and sign-ins, and what you allow below.'
        : 'Agents can reach the public internet. Your computer, your home network and cloud passwords are always off-limits.',
      seg([['open', 'Open'], ['strict', 'Locked down']], strict ? 'strict' : 'open', (v) => runJob(['network', v], v === 'strict' ? 'Locking down internet access' : 'Opening internet access'))),
      strict ? h('div', { class: 'sub-block' }, h('h3', {}, 'Also allowed'),
        rows(hosts.map(([x, who]) => h('li', {}, h('span', { class: 'grow mono' }, x), h('span', { class: 'muted small' }, who === 'all' ? 'All agents' : nameOf(who)),
          btn('Remove', () => runJob(['allow', 'rm', x, who], 'Stop allowing ' + x), 'sm ghost danger'))), 'Nothing extra.'), add) : null)),
    section('Blocked', 'Anything an agent tried that cage stopped.', h('div', { class: 'card flush' }, rows(ev, 'Nothing so far. That’s good.'))))
}

function pageSettings () {
  const S = STATE
  const st = S.settings
  const masks = h('div', { class: 'checks' }, agentsOn().map((a) => h('label', { class: 'check' }, h('input', {
    type: 'checkbox', checked: a.mask, onchange: (e) => runJob(['mask', e.target.checked ? 'on' : 'off', a.name], 'Privacy mask for ' + a.label)
  }), avatar(a.name, 16), a.label)))
  const term = h('input', { type: 'text', placeholder: 'A client, a project, a person', required: true, 'data-keep': 'mask-term' })
  const termForm = h('form', { class: 'add-row tight' }, term, h('button', { type: 'submit', class: 'btn' }, 'Hide this too'))
  termForm.addEventListener('submit', (e) => { e.preventDefault(); runJob(['mask', 'add', term.value.trim()], 'Privacy mask') })
  const tryIn = h('input', { type: 'text', placeholder: 'Try: email bob@acme.com about Acme', 'data-keep': 'mask-try' })
  const tryForm = h('form', { class: 'add-row tight' }, tryIn, h('button', { type: 'submit', class: 'btn' }, 'Preview'))
  tryForm.addEventListener('submit', (e) => { e.preventDefault(); if (tryIn.value) runJob(['mask', 'try', tryIn.value], 'What the AI company would see') })
  const fallbacks = h('div', { class: 'stack tight' }, agentsOn().map((a) => {
    const others = agentsOn().filter((b) => b.name !== a.name)
    return h('div', { class: 'row' }, h('span', { class: 'fallback-who' }, avatar(a.name, 16), a.label), icon('chevron-right', 'muted'), others.length ? fallbackSelect(a, others) : h('span', { class: 'muted small' }, 'nobody else yet'))
  }))
  const backups = S.backups.files.map((b) => h('li', {}, h('span', { class: 'chat-mark' }, icon('archive')), h('span', { class: 'grow' }, h('b', {}, b.name), h('span', { class: 'sub' }, `${size(b.size)} · ${ago(b.at)}`)),
    btn('Restore', () => runJob(['restore', b.path], 'Restore ' + b.name), 'sm ghost')))
  return h('div', { class: 'page' }, pageHead('Settings', ''),
    section('Privacy mask', 'Emails, phone and card numbers, bank details, keys and your own words reach the AI company as placeholders like [EMAIL_1], and come back as themselves. The agent can’t use a hidden value itself.', h('div', { class: 'card' },
      setting('Mask for', '', masks),
      setting('Also hide', 'Names of clients, projects or people.', h('div', { class: 'stack tight' },
        S.mask_terms.length ? h('div', { class: 'chips' }, S.mask_terms.map((t) => h('span', { class: 'chip' }, t, h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Stop hiding ' + t, onclick: () => runJob(['mask', 'rm', t], 'Privacy mask') }, icon('x'))))) : null,
        termForm), true),
      setting('Try it', 'See what the AI company would get.', tryForm))),
    section('Chats', '', h('div', { class: 'card' },
      setting('Ask everyone from chat', 'Start a message with /all (or @all) in any agent’s chat, and your other agents answer there too. Off: /all in chat does nothing.',
        toggle(st.ask_all === 'on', (on) => runJob(['ask-all', on ? 'on' : 'off'], '/all in chat'), '/all in chat')),
      setting('Voice notes', 'Send voice messages. “On this computer” turns them into text privately (a 300 MB download, once); Groq is faster, with your Groq key.',
        seg([['off', 'Off'], ['local', 'On this computer'], ['groq', 'Groq']], st.voice, (v) => runJob(v === 'off' ? ['voice', 'off'] : ['voice', 'on', v], 'Voice notes'))),
      setting('When an agent hits its usage limit', 'Another agent answers in its chat instead.', fallbacks, true))),
    section('This computer', '', h('div', { class: 'card' },
      setting('Start at login', 'Your agents wake up when you log in.', toggle(st.autostart, (on) => runJob(['autostart', on ? 'on' : 'off'], 'Start at login'), 'Start at login')),
      setting('Updates', `You have cage ${S.version}${newer(LATEST, S.version) ? '; ' + LATEST + ' is available' : ''}. Updating also gets each agent’s newest version.`, btn('Update', () => runJob(['update'], 'Updating cage'), '', 'download')),
      setting('Check everything', 'This computer, your settings and the chat bots.', btn('Run a check-up', () => runJob(['doctor'], 'Checking everything'), '', 'stethoscope')))),
    section('Backups', `One encrypted file with your settings, keys, sign-ins, and each agent’s login and files. Saved to ${S.backups.dir}.`, h('div', { class: 'card flush' },
      rows(backups, 'No backups yet.'), h('div', { class: 'card-foot' }, btn('Back up now', () => runJob(['backup'], 'Backing up'), 'primary', 'archive')))))
}

// --- jump to anything: Ctrl+K (⌘K) ---------------------------------------------------------------------------------
function paletteItems () {
  const S = STATE
  const items = [
    ['house', 'Home', () => go('home')],
    ['sparkles', 'Ask your agents', () => { go('home'); setTimeout(() => { const t = document.querySelector('.composer textarea'); if (t) t.focus() }, 60) }]
  ]
  for (const a of S.agents) items.push([null, a.label, () => go('agent/' + a.name), a.name, STATUS[statusOf(a)].label])
  items.push(['blocks', 'Apps', () => go('apps')], ['key-round', 'Sign-ins & keys', () => go('signins')], ['brain', 'Memory', () => go('memory')],
    ['shield', 'Security', () => go('security')], ['settings', 'Settings', () => go('settings')])
  if (agentsOn().some((a) => a.reachable && ['asleep', 'none'].includes(a.state))) items.push(['power', 'Wake everyone', () => runJob(['up'], 'Waking your agents')])
  items.push(['archive', 'Back up now', () => runJob(['backup'], 'Backing up')], ['stethoscope', 'Run a check-up', () => runJob(['doctor'], 'Checking everything')],
    ['download', 'Update cage', () => runJob(['update'], 'Updating cage')])
  return items
}
const pal = document.getElementById('palette')
function openPalette () {
  if (!STATE || !STATE.configured || dlg.open || pal.open) return
  const input = h('input', { type: 'text', placeholder: 'Go to, or do…', 'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false' })
  const list = h('ul', { class: 'pal-list', role: 'listbox' })
  let hits = []
  let at = 0
  const draw = () => {
    const q = input.value.trim().toLowerCase()
    hits = paletteItems().filter(([, label]) => !q || label.toLowerCase().includes(q))
    at = Math.min(at, Math.max(0, hits.length - 1))
    list.replaceChildren(...hits.map(([ic, label, fn, agent, note], i) => h('li', {
      role: 'option', class: i === at ? 'on' : '', 'aria-selected': i === at ? 'true' : 'false',
      onmousemove: () => { if (at !== i) { at = i; draw() } }, onclick: () => pick(i)
    }, agent ? avatar(agent, 18) : icon(ic), h('span', { class: 'grow' }, label), note ? h('span', { class: 'muted small' }, note) : null)))
    if (!hits.length) list.append(h('li', { class: 'pal-empty' }, 'Nothing matches.'))
  }
  const pick = (i) => { const it = hits[i]; if (!it) return; pal.close(); it[2]() }
  input.addEventListener('input', () => { at = 0; draw() })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(hits.length, 1); draw(); const el = list.children[at]; if (el) el.scrollIntoView({ block: 'nearest' }) }
    if (e.key === 'Enter') { e.preventDefault(); pick(at) }
  })
  pal.replaceChildren(h('div', { class: 'pal-search' }, icon('search'), input), list,
    h('div', { class: 'pal-foot' }, h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' to move'), h('span', {}, h('kbd', {}, 'Enter'), ' to open'), h('span', {}, h('kbd', {}, 'Esc'), ' to close')))
  draw()
  pal.showModal()
  input.focus()
}
pal.addEventListener('click', (e) => { if (e.target === pal) pal.close() })   // a click on the backdrop
document.addEventListener('keydown', (e) => {
  if (dlg.open) return   // in the side panel, Ctrl+K is the terminal's (and the panel is modal anyway)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (pal.open) pal.close(); else openPalette() }
  if (e.key === 'Escape' && document.body.classList.contains('nav-open')) document.body.classList.remove('nav-open')
})

// --- the frame: sidebar, routing ---------------------------------------------------------------------------------
function go (p) { location.hash = p }
function drawNav () {
  const S = STATE
  const list = document.getElementById('nav-agents')
  list.replaceChildren(...S.agents.slice().sort((a, b) => b.enabled - a.enabled).map((a) => {
    const st = STATUS[statusOf(a)]
    return h('a', { href: '#agent/' + a.name, 'data-nav': 'agent/' + a.name, class: a.enabled ? '' : 'off', title: a.label + ': ' + st.label },
      avatar(a.name, 18), h('span', { class: 'label' }, a.label), a.enabled ? dot(st.tone) : h('span', { class: 'nav-add' }, icon('plus')))
  }))
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page))
  const badge = (id, n) => { const b = document.getElementById(id); b.hidden = !n; b.textContent = n || '' }
  badge('badge-memory', S.memory.inbox)
  badge('badge-security', S.events.unseen)
  const ver = document.getElementById('version')
  ver.replaceChildren(h('span', {}, 'cage ' + S.version))
  if (newer(LATEST, S.version)) ver.append(h('button', { type: 'button', class: 'update', onclick: () => runJob(['update'], 'Updating cage') }, icon('download'), 'Update to ' + LATEST))
  const todo = agentsOn().filter((a) => ['login', 'stuck', 'nochat'].includes(statusOf(a))).length + S.connectors.filter((c) => c.broken).length + (S.events.unseen ? 1 : 0)
  document.title = todo ? `(${todo}) cage` : 'cage'
  document.getElementById('crumb').textContent = page.startsWith('agent/') ? nameOf(page.slice(6)) : ({ home: 'Home', apps: 'Apps', signins: 'Sign-ins & keys', memory: 'Memory', security: 'Security', settings: 'Settings' })[page] || ''
}
function render (force) {
  if (!STATE) return
  document.body.classList.remove('is-locked')
  document.body.classList.toggle('unconfigured', !STATE.configured)
  drawNav()
  const key = page + '\n' + LATEST + '\n' + JSON.stringify(STATE)
  const main = document.getElementById('main')
  if (!force && key === SEEN && main.dataset.page === page) return   // nothing changed
  // keep what you're typing: don't redraw a page while you're in one of its fields
  if (main.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && main.dataset.page === page) return
  const kept = {}
  if (main.dataset.page === page) main.querySelectorAll('[data-keep]').forEach((el) => { kept[el.dataset.keep] = el.value })
  const fn = !STATE.configured ? pageHome
    : page.startsWith('agent/') ? () => pageAgent(page.slice(6))
      : { home: pageHome, apps: pageApps, signins: pageSignins, memory: pageMemory, security: pageSecurity, settings: pageSettings }[page]
  const same = main.dataset.page === page
  main.dataset.page = page
  main.replaceChildren(fn())
  main.querySelectorAll('[data-keep]').forEach((el) => { if (kept[el.dataset.keep]) el.value = kept[el.dataset.keep] })
  if (!same) window.scrollTo(0, 0)
  SEEN = key
}
function route () {
  const raw = location.hash.slice(1)
  if (/^[0-9a-f]{32,}$/.test(raw)) { // the token, from `cage ui`
    TOKEN = raw
    try { localStorage.setItem('cage-token', TOKEN) } catch (e) {}
    history.replaceState(null, '', location.pathname + '#home')
  }
  const p = location.hash.slice(1)
  page = PAGES.includes(p) || /^agent\/[a-z]+$/.test(p) ? p : 'home'
  document.body.classList.remove('nav-open')
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

document.querySelectorAll('[data-icon]').forEach((el) => el.append(icon(el.dataset.icon)))
document.addEventListener('click', (e) => { // an open "for which agents" menu closes when you click elsewhere
  document.querySelectorAll('details.scope[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false })
})
document.getElementById('menu').addEventListener('click', () => document.body.classList.toggle('nav-open'))
document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'))
document.getElementById('nav').addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open') })
window.addEventListener('hashchange', route)
try { TOKEN = localStorage.getItem('cage-token') || '' } catch (e) {}
route()
if (!TOKEN) locked()
document.getElementById('jump').addEventListener('click', () => { document.body.classList.remove('nav-open'); openPalette() })
if (/Mac|iPhone|iPad/.test(navigator.platform)) document.getElementById('jump-key').textContent = '⌘K'
