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
  off: { label: 'Not set up', tone: 'off', help: '' }
}
const CHATS = [['telegram', 'Telegram'], ['slack', 'Slack'], ['discord', 'Discord'], ['whatsapp', 'WhatsApp']]
const PAGES = ['home', 'setup', 'apps', 'signins', 'memory', 'security', 'settings']

let TOKEN = ''
let STATE = null
let SEEN = ''      // the state last drawn, to redraw only when something changed
let LATEST = ''
let page = 'home'
let ASK = null     // the last question you asked from Home, and its answers (kept in this tab only)
let ACTIVITY = {}  // what each agent is doing, from the end of its chat (server.py's activity()): {pending, working, last, today}
const ANSWERED = {}   // approvals answered from Home, by when they were asked: gone at once, not at the next look
const FORGOTTEN = {}  // approvals that can't be answered any more, though an agent's chat says it waits for them (forgot())

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
  for (const kid of kids.flat(Infinity)) {
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
const LINK_RE = /(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])\*(?![\s*])[^*\n]+?(?<![\s*])\*(?![\w*])|(?<!\w)_(?![\s_])[^_\n]+?(?<![\s_])_(?!\w)|https?:\/\/[^\s<>"')\]]+)/g
function inline (text, plain) { // links (and, in answers, `code`, **bold**, *italic*, [text](url)) made real
  const out = []
  let last = 0
  for (const m of text.matchAll(plain ? /(https?:\/\/[^\s<>"')\]]+)/g : LINK_RE)) {
    const t = m[0]
    if (m.index > last) out.push(text.slice(last, m.index))
    if (t[0] === '`') out.push(h('code', {}, t.slice(1, -1)))
    else if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)))
    else if (t[0] === '*' || t[0] === '_') out.push(h('em', {}, t.slice(1, -1)))   // *italic* or _italic_
    else if (t[0] === '[') { // a link with words of its own: where it really goes is shown too
      const [, label, url] = /^\[([^\]]+)\]\((.+)\)$/.exec(t)
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, label))
      if (label.trim() !== url) out.push(h('span', { class: 'link-host' }, ' (' + hostOf(url) + ')'))
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
function size (n) { return n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' kB' : plural(n, 'byte') }
function plainLine (text, max) { // an agent's words on one line, without markdown's marks
  const t = String(text || '').replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
function plural (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')) }
function hostOf (url) { try { return new URL(url).hostname } catch (e) { return url } }

// The page's own messages and questions, in the page instead of the browser's alert() and confirm() boxes (which stop
// everything, look like the browser's own warnings, and can't be read out where they belong): a message that goes by
// itself (role=status), and a small sheet with two answers. The safe answer has the focus, and Esc means it.
function toast (text, tone) {
  const t = h('div', { class: 'toast ' + (tone || 'bad') }, icon(tone === 'ok' ? 'circle-check' : tone === 'info' ? 'info' : 'circle-alert'), h('span', { class: 'grow' }, text),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('x')))
  document.getElementById('toasts').append(t)
  setTimeout(() => t.remove(), 8000)
}
function confirmSheet (text, yes, no) { // → true for yes; false for no, Esc, or while another question is open
  const d = document.getElementById('confirm')
  if (d.open) return Promise.resolve(false)
  const yesB = document.getElementById('confirm-yes')
  const noB = document.getElementById('confirm-no')
  document.getElementById('confirm-text').textContent = text
  yesB.textContent = yes
  noB.textContent = no
  return new Promise((resolve) => {
    let answer = false
    yesB.onclick = () => { answer = true; d.close() }
    noB.onclick = () => d.close()
    d.addEventListener('close', () => resolve(answer), { once: true })
    d.showModal()
    noB.focus()
  })
}

// --- talking to the server ---------------------------------------------------------------------------------------
const NOT_ANSWERING = 'cage isn’t answering. Open the cage shortcut, or run cage ui.'
const OLD_APP = 'cage was updated, but its web app is still the old one. Run cage ui (or open the cage shortcut) to restart it.'
let OLD = false   // the web app answering is older than this page: it would drop a question sent the new way ("text")
async function api (path, opts = {}) {
  if (OLD && opts.body && opts.body.text !== undefined) throw new Error(OLD_APP)
  let res
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'X-Cage-Token': TOKEN, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    })
  } catch (e) { // the browser's own words ("Failed to fetch") say nothing
    const err = new Error(NOT_ANSWERING)
    err.down = true
    throw err
  }
  if (res.status === 401) { locked(); throw new Error('locked') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || res.statusText)
    err.status = res.status
    throw err
  }
  return data
}
let BOOTED = ''   // the cage version this page came with; after an update, the page reloads to get the new one
let FAILS = 0     // refreshes in a row that got no answer at all: after two, the page says so
let DOWN = false
// someone is typing in this, or picking from this list. A switch that has focus isn't, and nor is a list whose change
// cage is making (aria-busy): both can be drawn again from the state.
function typing (el) {
  if (!el) return false
  if (el.tagName === 'SELECT') return el.getAttribute('aria-busy') !== 'true'   // its open list would close in your hands
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|file|range|color)$/.test(el.type))
}
let UNSAVED = null   // the open page's "is there something you wrote and didn't save?", if it has one
function unsaved () { return !!UNSAVED && UNSAVED() }
async function refresh () {
  try {
    STATE = await api('/api/state')
    FAILS = 0
    notice(OLD ? 'old' : STATE.stale ? 'slow' : '')
    if (OLD) reattach()   // restarted yet?
    BOOTED = BOOTED || STATE.version
    if (STATE.version !== BOOTED && !running() && !typing(document.activeElement) && !unsaved()) {
      BOOTED = STATE.version   // once: the server restarts itself within seconds of an update (host/ui/server.py)
      setTimeout(() => location.reload(), 4000)
    }
    render()
    if (CHAT) drawChatState(CHAT)
    liveConnect()
    loadActivity()
    // plan usage, wherever it's shown: asked for when a page is drawn, and again while it sits there unchanged
    document.querySelectorAll('[data-usage]').forEach((el) => { const a = agentOf(el.dataset.usage); if (a) wantUsage(a) })
  } catch (e) {
    if (e.message === 'locked') return
    if (!e.down) { FAILS = 0; notice('slow') }   // the web app answers, but cage behind it was too slow (or failed)
    else if (++FAILS >= 2) notice('down')
    console.warn(e)
  }
}
// What each agent is doing (Home, the title): read from the end of its chat log. Two looks can overlap (the refresh,
// and something that happened in a chat): only the newest one's answer counts, as an older one that comes in later
// would show what was true before. ACT_LOAD is the newest look, until it has drawn what it found.
let ACT_SEQ = 0
let ACT_LOAD = Promise.resolve()
function loadActivity () {
  const n = ++ACT_SEQ
  ACT_LOAD = (async () => {
    const names = STATE ? agentsOn().map((a) => a.name) : []
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    let got
    try { got = names.length ? (await api(`/api/activity?agents=${names.join(',')}&since=${midnight.getTime()}`)).agents || {} : {} } catch (e) { return }
    if (n !== ACT_SEQ) return
    for (const [name, x] of Object.entries(got)) if (x.stopped && x.pending) forgot(name, x.pending)
    ACTIVITY = got
    render()
    if (CHAT) drawAsking(CHAT)
  })()
  return ACT_LOAD
}
let ACT_SOON = 0
function activitySoon () { clearTimeout(ACT_SOON); ACT_SOON = setTimeout(loadActivity, 400) }   // something happened in a chat
function waitingOf (name) { // the approval an agent waits for, unless you answered it from here already
  const p = (ACTIVITY[name] || {}).pending
  return p && ANSWERED[name] !== p.at ? p : null
}
// ...and can still be answered: cc-connect forgets an approval when it stops (asleep, say), and drops an answer to one
// it forgot without a word, so an Allow would seem to work and do nothing
function askingOf (a) { const p = a.state === 'ready' ? waitingOf(a.name) : null; return p && !forgotten(a.name, p) ? p : null }
// Nor once it's up again, for one it was waiting for while its VM wasn't running: the cc-connect that started when it
// woke never asked it, though its chat says it waits until the relay registers with that one, a while later. Kept
// here for each agent, by what it asked and when, from what server.py says of it ("stopped" in /api/activity, or its
// refusal of an answer). The page doesn't tell by itself: cage's state, which says an agent is asleep, can be seconds
// older than what its chat says, so an approval asked just after it woke up would look like one asked before.
function forgot (name, p) { FORGOTTEN[name] = { text: p.text, at: p.at } }
function forgotten (name, p) { const f = FORGOTTEN[name]; return !!f && !!p && f.text === p.text && (f.at || 0) === (p.at || 0) }
// The line at the top when cage itself is in the way: not answering at all (dots greyed, sending off), or slow
function notice (kind) {
  const el = document.getElementById('notice')
  const down = kind === 'down'
  document.body.classList.toggle('has-notice', !!kind)
  if (down !== DOWN) {
    DOWN = down
    document.body.classList.toggle('is-down', down)
    document.querySelectorAll('.composer .send').forEach((b) => { b.disabled = down || b.hasAttribute('data-idle') })
    if (CHAT) drawChatState(CHAT)
  }
  el.hidden = !kind
  if (!kind || el.dataset.kind === kind) return
  el.dataset.kind = kind
  el.className = 'notice ' + (down ? 'bad' : 'warn')
  el.replaceChildren(icon(down ? 'circle-alert' : kind === 'old' ? 'refresh-cw' : 'loader-circle'), h('span', { class: 'grow' }, down
    ? [h('b', {}, 'cage isn’t answering.'), ' Open the cage shortcut, or run ', h('code', {}, 'cage ui'), '. Trying again…']
    : kind === 'old' ? [h('b', {}, 'cage was updated, but its web app is still the old one.'), ' Run ', h('code', {}, 'cage ui'), ' (or open the cage shortcut) to restart it.']
      : 'cage is slow to answer, so what you see may be a little out of date.'))
}
function locked (text) {
  document.body.classList.add('is-locked')
  const main = document.getElementById('main')
  main.replaceChildren(document.getElementById('tpl-locked').content.cloneNode(true))
  if (text) main.querySelector('.locked p').textContent = text
}
function watch (id, onEvent) { // a job's events, as they happen (all of them, from the start)
  const es = new EventSource(`/api/jobs/${id}/events?from=0&token=${encodeURIComponent(TOKEN)}`)
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data)
    if (ev.t === 'exit') es.close()
    onEvent(ev)
  }
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) onEvent({ t: 'gone' }) }   // cage forgot it (it restarted)
  return es
}

// --- jobs: a cage command, as a conversation in the side panel ----------------------------------------------------
// One at a time. Closing the panel only hides it: the command carries on, a pill at the top brings it back (and finds
// it again after a reload). Stop is the only way to end one early.
const dlg = document.getElementById('job')
const logEl = document.getElementById('job-log')
const pill = document.getElementById('job-pill')
let job = null
function running () { return !!job && !job.done }
function setStatus (kind, text) {
  const s = document.getElementById('job-status')
  s.className = 'job-status ' + kind
  s.replaceChildren(kind === 'running' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(kind === 'done' ? 'circle-check' : 'circle-alert'), h('span', {}, text))
  dlg.classList.toggle('running', kind === 'running')
  document.getElementById('job-cancel').hidden = kind !== 'running'
  document.getElementById('job-hide').hidden = kind !== 'running'
  document.getElementById('job-close').hidden = kind === 'running'
  const x = document.getElementById('job-x')
  x.setAttribute('aria-label', kind === 'running' ? 'Hide' : 'Dismiss')
  x.title = kind === 'running' ? 'Hide (Esc). It keeps going.' : 'Dismiss (Esc)'
}
function drawPill () { // a job that's still going (or just finished) while its panel is hidden
  const show = !!job && !!job.hidden
  pill.hidden = !show
  document.body.classList.toggle('has-pill', show)
  if (!show) return
  const needs = !job.done && !!logEl.querySelector('.ask-box:not(.skip-box)')   // a question still waiting for an answer
  const [cls, ic, text] = !job.done ? (needs ? ['needs', icon('circle-question-mark'), 'Waiting for you: ' + job.title] : ['', h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Working: ' + job.title])
    : job.code ? ['bad', icon('circle-alert'), 'Didn’t work: ' + job.title] : ['ok', icon('circle-check'), 'Done: ' + job.title]
  pill.className = 'job-pill ' + cls
  pill.title = 'Show what it’s doing'
  pill.replaceChildren(ic, h('span', { class: 'pill-text' }, text), h('span', { class: 'pill-show', 'aria-hidden': 'true' }, 'Show'))
}
function showJob () {
  if (!job) return
  job.hidden = false
  drawPill()
  if (!dlg.open) {
    dlg.showModal()
    const box = logEl.querySelector('.ask-box:not(.skip-box) input, .ask-box:not(.skip-box) button')   // a question still waiting
    if (box) box.focus(); else logEl.focus()
  }
  if (job.fitTerm && !document.getElementById('job-term').hidden) setTimeout(job.fitTerm, 220)
  scrollDown()
}
function forgetJob () {
  if (job) {
    if (job.es) job.es.close()
    if (job.term) job.term.dispose()
    clearTimeout(job.fade)
  }
  job = null
  drawPill()
}
function sheet (title) { // an empty side panel, for a new job
  const termEl = document.getElementById('job-term')
  logEl.replaceChildren()
  termEl.hidden = true
  termEl.replaceChildren()
  dlg.classList.remove('wide')
  document.getElementById('job-title').textContent = title
  setStatus('running', 'Working…')
}
// Signing in without a terminal: a vendor's sign-in prints a link, maybe a code, maybe asks for one back. The panel
// shows those as a button, a code to copy and a box to paste into; the terminal itself is one click away.
const SIGNIN_JOBS = ['login', 'add', 'onboard']
// Where each vendor signs you in (and its subdomains: Claude Code's own sign-in pages are on claude.com and
// platform.claude.com). A link to anywhere else is still shown, but not as the big button, and with a warning: it
// comes from the agent's VM, which an agent that read the wrong web page could have changed.
const SIGNIN_HOSTS = ['claude.com', 'claude.ai', 'console.anthropic.com', 'auth.openai.com', 'chatgpt.com', 'cursor.com', 'accounts.google.com']
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>78]/g
function signinParts (plain) { // what a sign-in printed: {url, code, paste, known}
  const urls = [...plain.matchAll(/https:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/[).,;:]+$/, ''))
  const url = urls.reverse().find((u) => /oauth|authori[sz]e|login|device|signin|sign-in|activate|\bauth\b|accounts\./i.test(u)) || ''
  const lines = plain.split('\n')
  let code = ''
  lines.forEach((l, i) => { if (/code/i.test(l)) { const m = (l + ' ' + (lines[i + 1] || '')).match(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/); if (m) code = m[1] } })
  const paste = /paste|authori[sz]ation code|enter (the |your )?code|code here/i.test(lines.slice(-8).join('\n'))
  const host = url ? hostOf(url).toLowerCase() : ''
  return { url, code, paste, host, known: SIGNIN_HOSTS.some((x) => host === x || host.endsWith('.' + x)) }
}
function signinAssistant (agent) {
  const box = h('div', { class: 'signin' }, h('p', { class: 'muted small signin-wait' }, h('span', { class: 'spinner' }), 'Starting the sign-in…'))
  const dec = new TextDecoder()
  let text = ''
  let shown = null
  let found = false
  const A = { box, placed: false }
  A.feed = (bytes) => {
    text = (text + dec.decode(bytes, { stream: true })).slice(-60000)
    const p = signinParts(text.replace(ANSI, '').replace(/\r/g, ''))
    const key = [p.url, p.code, p.paste].join('|')
    if (key === shown) return
    shown = key
    if (p.url) found = true
    if (p.url) draw(p)
  }
  A.found = () => found
  A.started = () => /\S/.test(text.replace(ANSI, ''))
  function draw ({ url, code, paste, host, known }) {
    const qr = h('div', { class: 'signin-qr', hidden: true })
    const q = qrcode(0, 'M'); q.addData(url); q.make()
    qr.append(h('img', { src: q.createDataURL(5, 2), alt: 'QR code for the sign-in page' }), h('span', { class: 'small muted' }, 'Scan with your phone’s camera'))
    let second
    if (code) {
      second = [h('b', {}, 'Enter this code on that page'), h('div', { class: 'row' }, h('code', { class: 'signin-code' }, code),
        btn('Copy', (e) => { navigator.clipboard.writeText(code).then(() => { e.currentTarget.textContent = 'Copied' }).catch(() => {}) }, 'sm ghost', 'copy')),
      h('p', { class: 'small muted' }, 'This finishes by itself once you’ve approved it there.')]
    } else if (paste) {
      const input = h('input', { type: 'text', placeholder: 'Paste the code here', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'The code from the sign-in page' })
      const form = h('form', { class: 'ask-box flush' }, input, h('button', { type: 'submit', class: 'btn primary' }, 'Send'))
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        if (!input.value.trim()) return
        send({ raw: btoa(String.fromCharCode(...new TextEncoder().encode(input.value.trim() + '\r'))) })
        form.replaceWith(h('p', { class: 'chosen' }, icon('check'), 'Sent. Finishing the sign-in…'))
      })
      setTimeout(() => input.focus(), 50)
      second = [h('b', {}, 'Paste the code it gives you'), h('p', { class: 'small muted' }, 'After you sign in, the page shows a code. Copy it, then paste it here.'), form]
    } else {
      second = [h('b', {}, 'Approve, then come back'), h('p', { class: 'small muted' }, 'This finishes by itself once you’ve signed in there.')]
    }
    const vendor = (AGENT[agent] || {}).vendor || 'your AI company'
    box.replaceChildren(
      h('div', { class: 'signin-step' }, h('span', { class: 'step-num' }, '1'), h('div', { class: 'grow' }, h('b', {}, 'Open the sign-in page'),
        known ? h('p', { class: 'small muted' }, 'Sign in there with the account that has your plan.')
          : h('p', { class: 'note warn signin-warn' }, icon('triangle-alert'), h('span', {}, `This link goes to ${host}, not ${vendor}. Don’t sign in there unless you expected it.`)),
        h('div', { class: 'row' }, h('a', { class: 'btn' + (known ? ' primary' : ''), href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('external-link'), 'Open sign-in page'),
          btn('Copy link', (e) => { navigator.clipboard.writeText(url).then(() => { e.currentTarget.lastChild.textContent = 'Copied' }).catch(() => {}) }, 'sm ghost', 'copy'),
          btn('On your phone', () => { qr.hidden = !qr.hidden }, 'sm ghost', 'qr-code')),
        h('p', { class: 'small muted signin-host' }, 'Goes to ', h('b', {}, host)), qr)),
      h('div', { class: 'signin-step' }, h('span', { class: 'step-num' }, '2'), h('div', { class: 'grow' }, second)),
      h('button', { type: 'button', class: 'linkish small muted details-toggle', onclick: () => revealTerminal() }, 'Show what it’s doing'))
  }
  return A
}
function revealTerminal () {
  const el = document.getElementById('job-term')
  if (!job || !el.hidden) return
  el.hidden = false
  dlg.classList.add('wide')
  if (job.fitTerm) setTimeout(job.fitTerm, 220)
}

// A sign-in shows the helper above (not for Antigravity, whose sign-in is a terminal screen)
function assisted (args) { return SIGNIN_JOBS.includes(args[0]) && !args.includes('antigravity') }
// text: a question for `ask` or `mask try`, which the server hands to cage in a file instead of on its command line
async function runJob (args, title, onDone, text) {
  if (running()) { showJob(); return }   // one at a time: the one still going comes back instead
  forgetJob()
  title = title || ('cage ' + args.join(' '))
  sheet(title)
  dlg.showModal()
  logEl.focus()
  let id
  try { id = (await api('/api/jobs', { method: 'POST', body: { args, title, text, cols: assisted(args) ? 400 : 100 } })).id } catch (e) {
    BUSY = ''
    logEl.append(msg('bad', e.message)); setStatus('failed', 'That didn’t work'); return
  }
  attachJob(id, args, title, onDone)
}
function attachJob (id, args, title, onDone) {
  job = { id, args, title, done: false, term: null, onDone, signin: assisted(args) ? signinAssistant(args.find((a) => AGENT[a])) : null }
  job.es = watch(id, handle)
  drawPill()
}
function openJob (id, args, title, show) { // a job that's already running (after a reload), or one that's done (its log)
  if (job && job.id === id) { if (show) showJob(); return }
  if (running()) { if (show) showJob(); return }
  forgetJob()
  sheet(title)
  attachJob(id, args, title)
  if (show) showJob(); else { job.hidden = true; drawPill() }
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
  if (ev.t !== 'gone') job.got = true
  if (ev.t === 'raw') {
    const bytes = Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0))
    terminal().write(bytes)
    if (job.signin) {
      job.signin.feed(bytes)
      if (!job.signin.placed && job.signin.started()) { // the sign-in starts: the helper, or the terminal if it finds no link
        job.signin.placed = true
        logEl.append(job.signin.box)
        setTimeout(() => { if (job && job.signin && !job.signin.found()) revealTerminal() }, 15000)
      }
      scrollDown()
    }
    return
  }
  if (ev.t === 'input') { // an answer went in (from here, or another tab): its question isn't waiting any more
    const box = logEl.querySelector('.ask-box:not(.skip-box):not(.flush)')
    if (box) box.replaceWith(h('div', { class: 'answered' }, 'Answered'))
    if (job.hidden) drawPill()
    return
  }
  if (ev.t === 'exit' || ev.t === 'gone') {
    const J = job
    J.done = true
    J.code = ev.t === 'gone' ? -1 : ev.code
    logEl.querySelectorAll('.skip-box').forEach((b) => b.remove())
    logEl.querySelectorAll('.ask-box input, .ask-box button').forEach((el) => { el.disabled = true })
    // gone: cage forgot it, because it restarted while this went on, or (when nothing came at all) it ended a while ago
    if (ev.t === 'gone' && !J.got) logEl.append(msg('hint', 'cage keeps what something did for 10 minutes after it ends.'))
    const gone = J.got ? 'cage restarted before this finished' : 'This isn’t kept any more'
    setStatus(J.code ? 'failed' : 'done', ev.t === 'gone' ? gone : J.code ? 'That didn’t work — see above' : 'Done.')
    scrollDown()
    if (dlg.open) document.getElementById('job-close').focus()
    SEEN = ''   // redraw from what's true now: a switch shows what cage did, not what was clicked
    BUSY = ''
    refresh()
    if (!J.code && J.onDone) J.onDone()
    drawPill()
    if (job === J && J.hidden && !J.code) J.fade = setTimeout(() => { if (job === J && J.hidden) forgetJob() }, 6000)
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
  if (job.hidden && ['prompt', 'confirm'].includes(e.t)) drawPill()   // it waits for you now
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
  if (!job.signin) { el.hidden = false; dlg.classList.add('wide') }   // a sign-in keeps it tucked away
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
  const id = job.id
  const resize = () => { try { fit.fit(); api(`/api/jobs/${id}/resize`, { method: 'POST', body: { cols: term.cols, rows: term.rows } }).catch(() => {}) } catch (e) {} }
  if (!job.signin) setTimeout(resize, 220)   // after the panel has widened
  job.fitTerm = resize
  window.addEventListener('resize', () => { if (job && job.term === term && !el.hidden) resize() })   // (this job's terminal only)
  term.onData((d) => send({ raw: btoa(String.fromCharCode(...new TextEncoder().encode(d))) }))
  if (!job.signin) term.focus()
  job.term = term
  return term
}
// Stopping these halfway can leave things half done, so Stop asks first
const STOP_ASK = {
  add: 'Stop adding it? It may be left half set up. Adding it again finishes the job.',
  update: 'Stop the update? cage may be left half updated until you update again.',
  restore: 'Stop restoring? Your settings may be left half restored.',
  backup: 'Stop the backup? Nothing will be saved.'
}
document.getElementById('job-cancel').addEventListener('click', () => {
  if (!running()) return
  const J = job
  const stop = () => { if (job === J && running()) api(`/api/jobs/${J.id}/cancel`, { method: 'POST' }).catch(() => {}) }
  if (!STOP_ASK[J.args[0]]) return stop()
  confirmSheet(STOP_ASK[J.args[0]], 'Stop', 'Keep going').then((yes) => { if (yes) stop() })
})
document.getElementById('job-close').addEventListener('click', () => dlg.close())
document.getElementById('job-hide').addEventListener('click', () => dlg.close())
document.getElementById('job-x').addEventListener('click', () => dlg.close())
pill.addEventListener('click', showJob)
dlg.addEventListener('close', () => { // Esc, the X, Hide or Close: a job still going only goes out of sight
  SEEN = ''
  if (running()) {
    job.hidden = true
    drawPill()
  } else forgetJob()
  refresh()
})
window.addEventListener('pagehide', () => { // a log or a terminal is only there to be looked at
  if (running() && ['logs', 'shell'].includes(job.args[0])) navigator.sendBeacon(`/api/jobs/${job.id}/cancel?token=${encodeURIComponent(TOKEN)}`, new Blob(['{}'], { type: 'text/plain' }))
})

// --- building blocks ---------------------------------------------------------------------------------------------
function nameOf (a) { const x = STATE && STATE.agents.find((y) => y.name === a); return x ? x.label : a }
function agentsOn () { return STATE.agents.filter((a) => a.enabled) }
function statusOf (a) {
  if (!a.enabled) return 'off'
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
// Switches and lists that change a setting show what's true, not what was clicked: the click is put back at once and
// the control waits (aria-busy) until the state says the change was made; a stopped or failed change never shows.
let BUSY = ''   // the control whose change cage is making (by its label), until that job ends
function asked (el, was) {
  if (el.type === 'checkbox') el.checked = was; else el.value = was
  if (running()) return   // one job at a time: the one still going comes back instead, and this changes nothing
  BUSY = el.getAttribute('aria-label') || ''
  el.setAttribute('aria-busy', 'true')
}
function busy (label) { return BUSY && BUSY === label ? 'true' : null }
function toggle (on, onChange, label) { // a switch, on a real checkbox
  return h('label', { class: 'switch' }, h('input', {
    type: 'checkbox', checked: on, 'aria-label': label || null, 'aria-busy': busy(label), onchange: (e) => { asked(e.target, on); onChange(!on) }
  }), h('span', { class: 'track', 'aria-hidden': 'true' }))
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
  return h('details', { class: 'scope', 'data-open': name }, summary, h('div', { class: 'scope-menu' }, boxes))
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
  const placed = new Map()
  for (const a of agentsOn()) { const p = askingOf(a); if (p) out.push(approvalRow(a, p, placed.size, placed)) }
  PLACED = placed
  for (const a of agentsOn()) {
    const s = statusOf(a)
    if (s === 'login') out.push(item('warn', 'log-in', `${a.label} needs you to sign in to ${a.plan}`, btn('Sign in', () => runJob(['login', a.name], 'Sign ' + a.label + ' in'), 'sm')))
    if (s === 'stuck') out.push(item('bad', 'circle-alert', `${a.label} is stuck`, btn('Restart', () => runJob(['up', a.name], 'Restarting ' + a.label), 'sm')))
  }
  for (const c of S.connectors.filter((c) => c.broken)) out.push(item('bad', 'blocks', `${pretty(c.name)} needs you to sign in again`, btn('Sign in', () => runJob(['connect', 'add', c.name], 'Sign in to ' + pretty(c.name)), 'sm')))
  if (S.events.unseen > 0) out.push(item('bad', 'shield-alert', `cage blocked ${plural(S.events.unseen, 'thing')} since you last looked`, btn('Review', () => go('security'), 'sm')))
  if (S.memory.inbox > 0) out.push(item('info', 'brain', `Your agents want to remember ${plural(S.memory.inbox, 'new thing')}`, btn('Review', () => runJob(['memory'], 'What your agents want to remember'), 'sm')))
  if (newer(LATEST, S.version)) out.push(item('info', 'download', `cage ${LATEST} is available (you have ${S.version})`, btn('Update', () => runJob(['update'], 'Updating cage'), 'sm')))
  return out
}

// An agent waiting for your OK, though you're not in its chat: the same words as its card there, Allow and Deny right
// here, or Open to see it in the conversation first. Allow only when that line is all it asks (approvalWhole); else
// Open shows the rest. The answer goes with the approval it's for, so it answers that one or none (server.py refuses
// it once the agent has moved on).
// An Allow that has only just come to where it is doesn't count yet: a row drawn there a moment ago (one above it
// answered or gone, or one asked anew) would be allowed by a click or an Enter meant for what was there before. As
// browsers do with their own permission prompts, it waits a little first (aria-disabled, so it keeps the focus).
const SETTLE = 600
let PLACED = new Map()   // the approval rows on Home: where each one is, and since when (by agent and when it was asked)
function approvalRow (a, p, pos, placed) {
  const ap = approvalOf(p.text)
  const line = approvalLine(ap)
  const key = a.name + '\n' + p.at
  const was = PLACED.get(key)
  const since = was && was.pos === pos ? was.since : Date.now()
  if (placed) placed.set(key, { pos, since })
  const open = (main) => h('a', { class: 'btn sm ' + (main ? 'primary' : 'ghost'), href: '#agent/' + a.name, 'aria-label': 'Open ' + a.label + '’s chat' }, 'Open')
  const row = (sub, ...acts) => h('li', { class: 'attn warn approval-row' }, h('span', { class: 'attn-icon' }, icon('hand')),
    h('span', { class: 'grow' }, h('b', {}, `${a.label} wants your OK`), h('span', { class: 'sub' }, sub)), h('span', { class: 'attn-acts' }, acts))
  const decide = (action) => async (e) => {
    if (e.currentTarget.getAttribute('aria-disabled') === 'true') return   // (not yet)
    const b = e.currentTarget
    const li = b.closest('li')
    const had = li.contains(document.activeElement)   // (the keyboard's, or a click's)
    li.querySelectorAll('button').forEach((x) => { x.disabled = true })
    try {
      await api(`/api/chat/${a.name}/action`, { method: 'POST', body: { action, label: PERM_LABEL[action], pending: { text: p.text, at: p.at } } })
      ANSWERED[a.name] = p.at
      render()
      // The row is gone: the focus goes to the top of what needs you (not onto the next Allow, where a second Enter
      // would say yes to that), and a screen reader is told it went (the toasts are a status)
      if (had) {
        const head = [...document.querySelectorAll('#main h2')].find((x) => x.textContent === 'Needs you') || document.querySelector('#main h1')
        if (head) { head.tabIndex = -1; head.focus({ preventScroll: true }) }
      }
      toast(`${action === 'perm:deny' ? 'Denied' : 'Allowed'}: ${a.label}, ${line}`, action === 'perm:deny' ? 'info' : 'ok')
    } catch (err) {
      if (err.status === 409 && /^It stopped/.test(err.message)) { forgot(a.name, p); render() }   // (for good, and on its card too)
      toast(err.message)
      li.querySelectorAll('button').forEach((x) => { x.disabled = false })
      if (had && b.isConnected) b.focus()
    }
    activitySoon()
  }
  // (what a screen reader says for each, out of context: two agents may be waiting)
  const answer = (action, cls) => {
    const b = h('button', { type: 'button', class: 'btn ' + cls, 'aria-label': `${PERM_LABEL[action]}: ${a.label}, ${line}`, onclick: decide(action) }, PERM_LABEL[action])
    const wait = since + SETTLE - Date.now()
    if (action === 'perm:allow' && wait > 0) { b.setAttribute('aria-disabled', 'true'); setTimeout(() => b.removeAttribute('aria-disabled'), wait) }
    return b
  }
  // (on its own, so the time after it can't be drawn into it; what runs or where it goes in the order it's written, and
  // words to read, a subject or instructions, as written words are, each in a part of its own)
  let end = 0
  const parts = ap.what ? lineParts(ap).map(([t, prose]) => { const s = line.slice(end, end += t.length); return s ? h('span', prose ? {} : { class: 'exact' }, s) : null }) : [h('span', { class: 'exact' }, line)]
  const sub = [h('span', { dir: 'ltr' }, parts), p.at ? ' · ' + when(p.at) : '']
  if (!approvalWhole(ap)) {
    const why = ap.unseen ? 'It has characters that don’t show: open it to see where.' : ap.mixed ? 'It mixes letters from different alphabets: open it to see where.'
      : ap.rtl ? 'Some of it is written right to left: open it to see it in the order it’s sent.' : ap.blind ? 'It doesn’t say what it would write in the file.'
        : 'Only part of it fits here: open it to see all it asks.'
    return row([...sub, '. ' + why], open(true), answer('perm:deny', 'sm'))
  }
  return row(sub, answer('perm:allow', 'sm primary'), answer('perm:deny', 'sm'), open(false))
}
function when (at) { // 8:21 AM today; Mon 8:21 AM this week; Oct 3 before that
  const d = new Date(at)
  const days = (new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 864e5
  return days < 1 ? clock(at) : days < 7 ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + clock(at) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function composer () {
  const awake = agentsOn().filter((a) => a.state === 'ready')
  const ta = h('textarea', { rows: 2, placeholder: awake.length ? 'Ask all your agents something…' : 'Wake an agent up to ask it something', 'aria-label': 'Question for your agents', 'data-keep': 'ask', disabled: !awake.length })
  const pills = agentsOn().map((a) => {
    const ready = a.state === 'ready'
    return h('label', { class: 'pill' + (ready ? '' : ' disabled'), title: ready ? '' : nameOf(a.name) + ' is ' + STATUS[statusOf(a)].label.toLowerCase() },
      h('input', { type: 'checkbox', name: 'ask-who', value: a.name, checked: ready, disabled: !ready }), avatar(a.name, 16), h('span', {}, a.label))
  })
  const sendBtn = h('button', { type: 'submit', class: 'send', 'aria-label': 'Ask', title: 'Ask (Enter)', 'data-idle': !awake.length, disabled: !awake.length || DOWN }, icon('arrow-up'))
  const form = h('form', { class: 'composer' }, ta, h('div', { class: 'composer-bar' }, h('div', { class: 'pills' }, pills), sendBtn))
  const submit = () => {
    const q = ta.value.trim()
    const who = [...form.querySelectorAll('input[name=ask-who]:checked')].map((i) => i.value)
    if (!q || !who.length || DOWN || (ASK && !ASK.rounds.every((r) => r.done))) return
    ta.value = ''
    ask(q, who)
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit() })
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() } })
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px' })
  return form
}
async function ask (q, who) { // a new question: the answers come in side by side
  ASK = { id: Date.now(), agents: who, rounds: [], compare: null }
  askRound(q, q)
}
// One round of cage ask. `prompt` is what the agents get (with the earlier rounds for a follow-up), `q` what you typed.
async function askRound (q, prompt) {
  const thread = ASK
  const r = { q, agents: thread.agents.slice(), answers: {}, notes: [], error: '', done: false }
  thread.rounds.push(r)
  thread.compare = null
  drawAnswers()
  try {
    const { id } = await api('/api/jobs', { method: 'POST', body: { args: ['ask', ...thread.agents], text: prompt } })
    watch(id, (ev) => {
      if (ev.t === 'exit' || ev.t === 'gone') { r.done = true; if ((ev.code || ev.t === 'gone') && !r.error) r.error = 'Your agents couldn’t be asked.'; askSave(thread) } else if (ev.t === 'event') {
        const e = ev.event
        if (e.t === 'asking') r.agents = e.agents
        else if (e.t === 'answer') r.answers[e.agent] = e.text || ''
        else if (e.t === 'warn' || e.t === 'hint') r.notes.push(e.text)
        else if (e.t === 'bad') r.error = e.text
      }
      if (ASK === thread) drawAnswers()
    })
  } catch (e) { r.error = e.message; r.done = true; drawAnswers() }
}
// How long a question can be, in UTF-8 bytes as the server counts them (server.py's MAX_ASK): each agent's CLI gets it
// as one argument, which Linux caps at 128 KiB. In Cyrillic or Chinese, that's far fewer characters than in English.
const MAX_ASK = 120 * 1024
const utf8 = (s) => new TextEncoder().encode(s)
function transcript (thread, room) { // the rounds so far, for a follow-up or a comparison: as much of the end as fits
  const all = utf8(thread.rounds.map((r, i) => `Question ${i + 1}: ${r.q}\n\n` + r.agents.map((a) => `${nameOf(a)} answered:\n${r.answers[a] || '(no answer)'}`).join('\n\n')).join('\n\n---\n\n'))
  if (all.length <= room) return new TextDecoder().decode(all)
  const cut = Math.max(0, room - 3)   // the start goes, and "…" says so (a character split in two goes too)
  return '…' + new TextDecoder().decode(all.subarray(all.length - cut)).replace(/^\uFFFD+/, '')
}
function withTranscript (head, thread, tail) { return head + transcript(thread, MAX_ASK - utf8(head + tail).length) + tail }
function followUp (text) {
  askRound(text, withTranscript('You and other AI assistants were asked the questions below. Their answers are included, so you can build on them or disagree.\n\n',
    ASK, `\n\n---\n\nFollow-up question: ${text}`))
}
async function compare () { // one agent reads all the answers: where they agree, where they don't
  const thread = ASK
  const r = thread.rounds[thread.rounds.length - 1]
  const by = (STATE.agents.find((a) => a.name === 'claude' && a.state === 'ready') || agentsOn().find((a) => a.state === 'ready') || {}).name
  if (!by) return
  thread.compare = { by, text: '', done: false, error: '' }
  drawAnswers()
  const text = withTranscript(`Several AI assistants answered the same question. Compare their answers for the person who asked: in a few short bullets, where they agree, where they disagree (and who is more likely right), and anything worth double-checking. Don't repeat the answers.\n\n`, { rounds: [r] }, '')
  try {
    const { id } = await api('/api/jobs', { method: 'POST', body: { args: ['ask', by], text } })
    watch(id, (ev) => {
      const c = thread.compare
      if (!c) return
      if (ev.t === 'exit' || ev.t === 'gone') { c.done = true; if (!c.text) c.error = c.error || 'No comparison came back.' } else if (ev.t === 'event' && ev.event.t === 'answer') c.text = ev.event.text || ''
      else if (ev.t === 'event' && ev.event.t === 'bad') c.error = ev.event.text
      if (ASK === thread) drawAnswers()
    })
  } catch (e) { thread.compare.error = e.message; thread.compare.done = true; drawAnswers() }
}
// Earlier questions, kept in this browser only (they never leave this computer)
function askHistory () { try { return JSON.parse(localStorage.getItem('cage-asks') || '[]') } catch (e) { return [] } }
function askSave (thread) {
  if (!thread.rounds.every((r) => r.done)) return
  const keep = askHistory().filter((t) => t.id !== thread.id)
  keep.unshift({ id: thread.id, agents: thread.agents, rounds: thread.rounds.map(({ q, agents, answers }) => ({ q, agents, answers, done: true, notes: [], error: '' })) })
  try { localStorage.setItem('cage-asks', JSON.stringify(keep.slice(0, 20))) } catch (e) {}
}
function roundView (r, i) {
  const cards = r.agents.map((a) => {
    const has = a in r.answers
    const text = r.answers[a] || ''
    const body = has ? (text ? md(text) : h('p', { class: 'muted' }, 'No answer. It may be signed out, busy, or out of quota.'))
      : r.done ? h('p', { class: 'muted' }, 'No answer.') : h('div', { class: 'skeleton' }, h('span'), h('span'), h('span'))
    return h('article', { class: 'answer-card' + (has ? '' : ' waiting'), style: { '--c': AGENT[a] && AGENT[a].color } },
      h('header', {}, avatar(a, 20), h('b', {}, nameOf(a)), h('span', { class: 'answer-state' }, has ? (text ? 'Answered' : 'No answer') : r.done ? '' : 'Thinking…'),
        has && text ? h('button', { type: 'button', class: 'icon-btn', title: 'Copy', 'aria-label': 'Copy ' + nameOf(a) + '’s answer', onclick: (e) => { navigator.clipboard.writeText(text).then(() => { e.currentTarget.replaceChildren(icon('check')) }).catch(() => {}) } }, icon('copy')) : null),
      body)
  })
  return h('div', { class: 'round' },
    h('div', { class: 'answers-q' }, h('span', { class: 'you' }, i ? 'Follow-up' : 'You asked'), h('p', {}, r.q), r.done ? null : h('span', { class: 'muted small' }, 'Up to 5 minutes')),
    r.error ? h('p', { class: 'note bad' }, icon('circle-alert'), r.error) : null,
    cards.length ? h('div', { class: 'answers-grid', style: { '--n': Math.min(cards.length, 3) } }, cards) : null,
    r.notes.map((n) => h('p', { class: 'note' }, icon('info'), n)))
}
function answers () {
  const past = askHistory().filter((t) => !ASK || t.id !== ASK.id)
  const history = past.length ? h('details', { class: 'disclosure history', 'data-open': 'ask-history' }, h('summary', {}, icon('rotate-ccw'), `Earlier questions (${past.length})`),
    h('ul', { class: 'list' }, past.map((t) => h('li', {}, h('span', { class: 'grow' }, h('b', {}, t.rounds[0].q), h('span', { class: 'sub' }, `${t.rounds.length > 1 ? plural(t.rounds.length - 1, 'follow-up') + ' · ' : ''}${t.agents.map(nameOf).join(', ')} · ${ago(t.id / 1000)}`)),
      btn('Open', () => { ASK = { ...t, compare: null }; drawAnswers() }, 'sm ghost')))),
    h('button', { type: 'button', class: 'linkish small muted', onclick: () => { try { localStorage.removeItem('cage-asks') } catch (e) {} drawAnswers() } }, 'Forget these')) : null
  if (!ASK) return h('div', { id: 'answers', class: 'answers' }, history)
  const last = ASK.rounds[ASK.rounds.length - 1]
  const done = ASK.rounds.every((r) => r.done)
  const answered = Object.values(last.answers).filter(Boolean).length
  const C = ASK.compare
  const fu = h('input', { type: 'text', placeholder: 'Ask a follow-up… (they see the answers so far)', 'aria-label': 'Follow-up question', 'data-keep': 'follow-up' })
  const fuForm = h('form', { class: 'add-row tight follow-up' }, fu, h('button', { type: 'submit', class: 'btn' }, icon('send'), 'Ask'))
  fuForm.addEventListener('submit', (e) => { e.preventDefault(); if (fu.value.trim()) followUp(fu.value.trim()) })
  return h('div', { id: 'answers', class: 'answers' },
    ASK.rounds.map(roundView),
    C ? h('article', { class: 'compare-card' }, h('header', {}, icon('split'), h('b', {}, 'Where they agree and differ'), h('span', { class: 'answer-state' }, avatar(C.by, 16), nameOf(C.by))),
      C.text ? md(C.text) : C.error ? h('p', { class: 'note bad' }, icon('circle-alert'), C.error) : h('div', { class: 'skeleton' }, h('span'), h('span'))) : null,
    done ? h('div', { class: 'answers-actions' },
      answered > 1 && !C ? btn('Where do they disagree?', compare, 'sm', 'split') : null,
      btn('Clear', () => { ASK = null; drawAnswers() }, 'sm ghost')) : null,
    done && answered ? fuForm : null,
    history)
}
function drawAnswers () { const el = document.getElementById('answers'); if (el) el.replaceWith(answers()) }

function agentRow (a) {
  const s = statusOf(a)
  const st = STATUS[s]
  const chats = ['here', ...CHATS.filter(([k]) => a.chats[k]).map(([, n]) => n)]
  let action = null
  if (s === 'off') action = btn('Add', () => runJob(['add', a.name], 'Adding ' + a.label), 'sm')
  else if (s === 'login') action = btn('Sign in', () => runJob(['login', a.name], 'Sign ' + a.label + ' in'), 'sm')
  else action = h('a', { class: 'btn sm', href: '#agent/' + a.name }, icon('message-circle'), 'Chat')
  const act = a.enabled && ACTIVITY[a.name]
  const last = act && act.last
  const doing = !act ? null : askingOf(a) ? h('span', { class: 'agent-act warn' }, dot('warn'), 'Waiting for your OK')
    : waitingOf(a.name) ? h('span', { class: 'agent-act' }, 'It stopped while waiting for your OK, so it won’t go ahead')
    : act.working ? h('span', { class: 'agent-act busy' }, dot('busy'), 'Working…')
      : last ? h('span', { class: 'agent-act' }, 'Last: ', last.t === 'file' ? 'sent ' + last.text : plainLine(last.text, 80), last.at ? ' · ' + when(last.at) : '') : null
  return h('li', { class: 'agent' + (a.enabled ? '' : ' off'), style: { '--c': AGENT[a.name].color } },
    h('a', { class: 'agent-main', href: '#agent/' + a.name },
      avatar(a.name, 36),
      h('span', { class: 'agent-text' }, h('span', { class: 'agent-name' }, a.label),
        h('span', { class: 'agent-sub' }, h('span', { class: 'status ' + st.tone }, dot(st.tone), st.label),
          a.enabled ? ' · Chat ' + chats.join(', ').replace(/, ([^,]*)$/, ' and $1') : ' · uses ' + a.plan), doing)),
    action, h('a', { class: 'chev', href: '#agent/' + a.name, 'aria-label': 'Open ' + a.label }, icon('chevron-right')))
}

function pageHome () {
  const S = STATE
  if (!S.configured) return pageWelcome()
  const todo = attention()
  const sleepy = agentsOn().filter((a) => a.reachable && ['asleep', 'none'].includes(a.state))
  return h('div', { class: 'page' }, h('h1', { class: 'sr-only' }, 'Home'),
    todo.length ? section('Needs you', '', h('ul', { class: 'list attn-list' }, todo)) : null,
    h('section', { class: 'section hero' }, h('div', { class: 'section-head' }, h('h2', {}, 'Ask your agents'),
      h('p', {}, 'Each awake agent answers on its own, side by side. When they agree, you can be fairly sure; when they don’t, that’s the part worth a closer look.')), composer(),
    h('p', { class: 'small muted plan-note' }, 'Each agent you ask uses its own plan.'), answers()),
    section('Your agents', '', h('div', { class: 'section-tools' }, sleepy.length ? btn('Wake everyone', () => runJob(['up'], 'Waking your agents'), 'sm ghost', 'power') : null),
      h('ul', { class: 'list agents' }, S.agents.slice().sort((a, b) => b.enabled - a.enabled).map(agentRow)),
      h('p', { class: 'small muted foot' }, S.settings.ask_all === 'on' ? 'In any chat, start a message with /all to ask all of them from there too.' : 'Tip: turn on “Ask everyone from chat” in Settings to do this from your phone too.')),
    agentsOn().length ? section('Plan left', 'How much each one has left before its plan’s limit. Checked every 10 minutes.',
      h('ul', { class: 'list boxed plans' }, agentsOn().map((a) => { wantUsage(a); return h('li', {}, avatar(a.name, 24), h('b', { class: 'plan-who' }, a.label), h('div', { class: 'grow usage', 'data-usage': a.name, 'data-offer': '1' }, usageView(a, true))) }))) : null)
}

function pageWelcome () {
  const stepsList = [
    ['Pick your agents', 'Claude Code, Codex, Cursor or Antigravity, on the plans you already pay for.'],
    ['Sign in once', 'Each agent signs in to your plan inside its own private computer.'],
    ['Chat with them here', 'Or from your phone: Telegram, Slack, Discord and WhatsApp work too.']
  ]
  return h('div', { class: 'page welcome' },
    h('div', { class: 'welcome-hero' },
      h('img', { src: 'logo.svg', alt: '', width: 88, height: 88 }),
      h('h1', {}, 'AI agents you can text, each in its own cage'),
      h('p', { class: 'lede' }, 'Every agent runs on its own sealed-off computer on this machine, so it can work freely without touching your files, passwords or network. You chat with it right here, or from your phone.'),
      btn('Set up cage', () => { setupGo('computer'); go('setup') }, 'primary lg'),
      h('p', { class: 'small muted' }, 'Takes about five minutes.')),
    h('ol', { class: 'steps' }, stepsList.map(([t, d], i) => h('li', {}, h('span', { class: 'step-num' }, String(i + 1)), h('b', {}, t), h('span', {}, d)))),
    restoreBox())
}
function restoreBox () { // moving to a new computer: put a backup back before anything else
  // Only from cage's backups folder: restoring runs the backup's settings, so the app won't take a file from anywhere
  return h('details', { class: 'disclosure', 'data-open': 'restore' }, h('summary', {}, icon('archive'), 'Moving from another computer? Restore a backup'),
    h('p', { class: 'small muted' }, 'Your settings, keys, sign-ins, and each agent’s login and files.'),
    STATE.backups.files.length ? rows(STATE.backups.files.map((b) => h('li', {}, h('span', { class: 'grow' }, b.name, ' ', h('span', { class: 'muted small' }, ago(b.at))),
      btn('Restore', () => runJob(['restore', b.path], 'Restoring ' + b.name), 'sm')))) : null,
    h('div', { class: 'row restore-where' }, h('p', { class: 'small muted grow' }, 'Copy your backup file into ', h('code', {}, STATE.backups.dir), ', and it shows up here.'),
      btn('Look again', () => refresh(), 'sm ghost', 'refresh-cw')))
}

// --- setting up: this computer, your agents, signing in, a little about you --------------------------------------------
// A wizard instead of a conversation: each step shows where you are, what's next and what's in the way, in words.
const SETUP_STEPS = [['computer', 'This computer'], ['agents', 'Your agents'], ['signin', 'Sign in'], ['about', 'About you'], ['done', 'Done']]
const AGENT_BLURB = {
  claude: 'Anthropic’s agent. Needs Claude Pro or Max.',
  codex: 'OpenAI’s agent. Needs a ChatGPT Plus, Pro or Business plan.',
  cursor: 'Cursor’s agent. Needs a Cursor account.',
  antigravity: 'Google’s agent. Needs Google AI Pro or Ultra.'
}
let SETUP = { step: '', checks: null, picked: null, it: false }
function setupStep () {
  if (!SETUP.step) { try { SETUP.step = localStorage.getItem('cage-setup') || 'computer' } catch (e) { SETUP.step = 'computer' } }
  return SETUP.step
}
function setupGo (step) {
  SETUP.step = step
  try { if (step) localStorage.setItem('cage-setup', step); else localStorage.removeItem('cage-setup') } catch (e) {}
  render(true)
  window.scrollTo(0, 0)
}
function pageSetup () {
  const step = setupStep()
  const at = SETUP_STEPS.findIndex(([k]) => k === step)
  const rail = h('ol', { class: 'setup-rail' }, SETUP_STEPS.map(([k, label], i) =>
    h('li', { class: i < at ? 'past' : i === at ? 'now' : '' }, h('span', { class: 'step-num' }, i < at ? icon('check') : String(i + 1)), label)))
  const body = { computer: setupComputer, agents: setupAgents, signin: setupSignin, about: setupAbout, done: setupDone }[step] || setupComputer
  return h('div', { class: 'page setup' }, h('div', { class: 'setup-top' }, h('img', { src: 'logo.svg', alt: '', width: 36, height: 36 }), h('b', {}, 'Setting up cage'),
    h('button', { type: 'button', class: 'linkish small muted', onclick: () => { setupGo(''); go('home') } }, 'Later')), rail, h('section', { class: 'setup-card' }, body()))
}
function setupComputer () {
  const box = h('div', { class: 'checks-list' }, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' Looking at this computer…'))
  const load = async () => {
    SETUP.checks = null
    try { SETUP.checks = (await api('/api/check')).checks } catch (e) { SETUP.checks = [{ id: 'x', status: 'bad', title: 'Couldn’t check this computer', detail: e.message }] }
    render(true)
  }
  if (!SETUP.checks) { load(); return [h('h1', {}, 'First, this computer'), h('p', { class: 'lede' }, 'cage runs each agent in a small private computer of its own. Let’s make sure this one can.'), box] }
  const C = SETUP.checks
  const bad = C.filter((c) => c.status === 'bad')
  const fixable = bad.filter((c) => c.fix)
  const it = bad.filter((c) => c.it)
  const note = it.length ? itNote(it) : ''
  return [
    h('h1', {}, bad.length ? 'A few things to sort out' : 'This computer is ready'),
    h('p', { class: 'lede' }, bad.length ? 'cage can fix some of these itself. On a work computer, your IT department may need to do the rest.' : 'Everything your agents need is here.'),
    h('ul', { class: 'checks-list' }, C.map((c) => h('li', { class: 'check-row ' + c.status }, h('span', { class: 'check-ic' }, icon(c.status === 'ok' ? 'circle-check' : c.status === 'warn' ? 'triangle-alert' : 'circle-alert')),
      h('span', { class: 'grow' }, h('b', {}, c.title), c.detail ? h('span', { class: 'sub' }, c.detail) : null)))),
    it.length ? h('div', { class: 'it-note' + (SETUP.it ? ' open' : '') },
      h('div', { class: 'row spread' }, h('span', {}, icon('users'), ' A note for your IT department'),
        btn(SETUP.it ? 'Copy it' : 'Show the note', () => { if (SETUP.it) navigator.clipboard.writeText(note).catch(() => {}); SETUP.it = true; render(true) }, 'sm', SETUP.it ? 'copy' : null)),
      SETUP.it ? h('textarea', { readonly: true, rows: 9, 'aria-label': 'A note for your IT department' }, note) : null) : null,
    h('div', { class: 'setup-actions' },
      fixable.length ? btn('Fix ' + (fixable.length === 1 ? 'it' : 'these') + ' for me', () => runJob(['fix'], 'Getting this computer ready', load), 'primary', 'sparkles') : null,
      bad.length ? btn('Check again', load, '', 'refresh-cw') : btn('Continue', () => setupGo('agents'), 'primary'),
      bad.length ? h('button', { type: 'button', class: 'linkish small muted', onclick: () => setupGo('agents') }, 'Continue anyway') : null)
  ]
}
function itNote (items) {
  return `Hi,\n\nI'd like to use cage (https://github.com/z-brenner/cage), which runs AI assistants on this computer, each in a small local virtual machine (WSL 2 on Windows). It needs:\n\n${items.map((c) => '- ' + c.it).join('\n')}\n\nIt doesn't open any ports to the network. Could you help me set this up?\n\nThanks!`
}
function setupAgents () {
  if (!SETUP.picked) SETUP.picked = new Set(STATE.agents.filter((a) => a.enabled).map((a) => a.name))
  const P = SETUP.picked
  return [
    h('h1', {}, 'Which agents do you want?'),
    h('p', { class: 'lede' }, 'Pick the ones you have a plan for. Each one gets its own private computer and uses your own subscription. You can add more later.'),
    h('div', { class: 'pick-grid' }, STATE.agents.map((a) => h('label', { class: 'pick' + (P.has(a.name) ? ' on' : '') },
      h('input', { type: 'checkbox', checked: P.has(a.name), onchange: (e) => { if (e.target.checked) P.add(a.name); else P.delete(a.name); render(true) } }),
      avatar(a.name, 40), h('span', { class: 'grow' }, h('b', {}, a.label), h('span', { class: 'sub' }, AGENT_BLURB[a.name])),
      h('span', { class: 'pick-mark', 'aria-hidden': 'true' }, icon('check'))))),
    h('div', { class: 'setup-actions' },
      btn('Back', () => setupGo('computer'), 'ghost'),
      btn(P.size ? `Set up ${P.size === 1 ? 'this agent' : 'these ' + P.size}` : 'Pick at least one', () => {
        if (!P.size) return
        const fresh = [...P].filter((n) => !agentOf(n).enabled)
        if (!fresh.length) return setupGo('signin')
        runJob(['add', '--no-login', ...fresh], 'Setting up your agents', () => { dlg.close(); setupGo('signin') })
      }, 'primary'))
  ]
}
function setupSignin () {
  const mine = agentsOn()
  const ready = mine.filter((a) => a.state === 'ready')
  return [
    h('h1', {}, 'Sign each one in'),
    h('p', { class: 'lede' }, 'Once, with the account that has your plan. Each agent keeps its own sign-in on its own computer.'),
    h('ul', { class: 'list boxed signin-list' }, mine.map((a) => {
      const s = statusOf(a)
      let right
      if (s === 'ready') right = h('span', { class: 'status ok' }, icon('circle-check'), 'Signed in')
      else if (s === 'login') right = btn('Sign in', () => runJob(['login', a.name], 'Sign ' + a.label + ' in'), 'sm primary', 'log-in')
      else if (s === 'installing') right = h('span', { class: 'status busy' }, h('span', { class: 'spinner' }), 'Getting ready')
      else if (s === 'stuck') right = btn('Restart', () => runJob(['up', a.name], 'Restarting ' + a.label), 'sm')
      else right = btn('Wake up', () => runJob(['up', a.name], 'Waking ' + a.label), 'sm')
      return h('li', {}, avatar(a.name, 32), h('span', { class: 'grow' }, h('b', {}, a.label),
        h('span', { class: 'sub' }, s === 'installing' ? 'Installing its tools: a few minutes the first time. You can sign the others in meanwhile.' : 'Uses ' + a.plan + '.')), right)
    })),
    h('div', { class: 'setup-actions' },
      btn('Back', () => setupGo('agents'), 'ghost'),
      btn(ready.length ? 'Continue' : 'Skip for now', () => setupGo('about'), ready.length ? 'primary' : ''))
  ]
}
function setupAbout () {
  const ta = aboutBox('about-setup', { rows: 6, placeholder: 'e.g. I’m Sam, a contracts lawyer in Berlin. Short answers, British English, and cite your sources.', 'aria-label': 'About you' })
  return [
    h('h1', {}, 'A little about you'),
    h('p', { class: 'lede' }, 'Every agent reads this, so you don’t have to repeat yourself. Optional; you can change it any time under Memory.'),
    ta,
    h('div', { class: 'setup-actions' },
      btn('Back', () => setupGo('signin'), 'ghost'),
      btn('Skip', () => setupGo('done'), ''),
      btn('Save and continue', async () => {
        const text = aboutText('about-setup').trim()
        if (text && text !== ABOUT.saved) {
          const body = /^# About me/.test(text) ? text + '\n' : '# About me\n\n' + text + '\n'
          try { await api('/api/memory/about', { method: 'PUT', body: { text: body } }); ABOUT.saved = body } catch (e) { toast(e.message); return }
        }
        setupGo('done')
      }, 'primary'))
  ]
}
function setupDone () {
  const first = agentsOn().find((a) => a.state === 'ready') || agentsOn()[0]
  const auto = h('input', { type: 'checkbox', name: 'start-at-login', value: 'on', checked: true })
  return [
    h('div', { class: 'done-hero' }, h('img', { src: 'logo.svg', alt: '', width: 72, height: 72 }), h('h1', {}, 'You’re all set'),
      h('p', { class: 'lede' }, first ? `Chat with ${first.label} right here. Its page also has its files and settings.` : 'Add an agent any time from the sidebar.')),
    h('label', { class: 'check big-check' }, auto, h('span', {}, h('b', {}, 'Start my agents when I log in'), h('span', { class: 'sub' }, 'So they’re ready when you message them.'))),
    h('p', { class: 'small muted' }, 'Want them on your phone too? Each agent’s Settings tab connects Telegram, Slack, Discord or WhatsApp.'),
    h('div', { class: 'setup-actions' },
      btn(first ? 'Start chatting' : 'Open cage', () => {
        if (auto.checked && !STATE.settings.autostart) quietJob(['autostart', 'on'])
        setupGo('')
        go(first ? 'agent/' + first.name : 'home')
      }, 'primary lg'))
  ]
}

// --- one agent: its chat, its files, its settings --------------------------------------------------------------------
// The chat goes through a folder its VM shares (guest/app.mjs relays it to cc-connect there); the page reads the
// log as it grows and writes what you send. Everything an agent says is shown as text, never as HTML.
const STARTERS = [
  ['Summarize a document', 'Summarize the attached document in five bullet points, then list any deadlines and action items.'],
  ['Draft a reply', 'Draft a short, friendly reply to this email:\n\n'],
  ['Research, with sources', 'Look into this and give me a short answer with links to your sources: '],
  ['Notes into a brief', 'Turn these notes into a one-page brief: a summary, the key points and next steps.\n\n'],
  ['Proofread', 'Proofread this and suggest clearer wording, keeping my tone:\n\n'],
  ['Plan it out', 'Make a step-by-step plan with a checklist for: ']
]
let CHAT = null   // the open chat (one at a time): its element stays put while the page around it is redrawn

// Recipes: ready-made tasks for knowledge work, to run now from the chat or on a schedule. Each says what it needs, as
// honestly as can be told from here: Zapier connected is no proof that Gmail is added to your Zapier server, so the
// tile names the apps too. A {blank} is yours to fill in (it's selected for you, and nothing goes until it's filled).
const RECIPES = [
  { id: 'briefing', title: 'Morning briefing', blurb: 'Today’s meetings and the emails that need you, before you start.',
    prompt: 'Give me my morning briefing: today’s meetings (who, when, and what to prepare) and the emails from the last day that need me, most important first. Keep it short, and don’t send or change anything.',
    schedule: { kind: 'weekdays', time: '07:45' }, needs: ['zapier'], apps: 'Gmail and Google Calendar, through Zapier' },
  { id: 'triage', title: 'Inbox triage', blurb: 'What needs a reply, what’s for your information, what can wait. With drafts.',
    prompt: 'Go through my inbox from the last day. Sort it into: needs a reply from me, for my information, and can wait. Write short replies for the first group as drafts in Gmail, but don’t send anything.',
    schedule: { kind: 'weekdays', time: '12:00' }, needs: ['zapier'], apps: 'Gmail, through Zapier' },
  { id: 'meetings', title: 'Prep for tomorrow’s meetings', blurb: 'Who’s coming, what it’s about, and what to ask.',
    prompt: 'Look at tomorrow’s meetings in my calendar. For each one: who’s coming, what it’s about, my recent emails with them, and two or three questions I could ask.',
    schedule: { kind: 'weekdays', time: '17:00' }, needs: ['zapier'], apps: 'Google Calendar and Gmail, through Zapier' },
  { id: 'status', title: 'Friday status draft', blurb: 'Your week in five bullets, ready to send.',
    prompt: 'Draft my weekly status update for {who it’s for}: what I got done this week (from my sent emails and my calendar), what’s next, and anything I’m stuck on. Five bullets at most, and don’t send it.',
    schedule: { kind: 'weekly', time: '15:00', day: 5 }, needs: ['zapier'], apps: 'Gmail and Google Calendar, through Zapier' },
  { id: 'contract', title: 'Contract or NDA first pass', blurb: 'The terms that matter and what to push back on.',
    prompt: 'Read the attached contract. List the parties, the term and renewal, payment, liability caps, termination rights, confidentiality, and anything unusual or one-sided, with the clause numbers. Then say what I should push back on, and why. This is a first pass for me to check, not legal advice.',
    attach: true, needs: [], apps: 'the contract you attach' },
  { id: 'news', title: 'News watch on {topic}', blurb: 'The day’s five most important stories, with links.',
    prompt: 'Look for news from the last day about {topic}. Give me the five most important stories, one line each, with a link to each source. Leave out anything you told me about before.',
    schedule: { kind: 'daily', time: '08:00' }, needs: ['web'], apps: 'the web' },
  { id: 'followups', title: 'Follow-ups I owe', blurb: 'What you promised, or still owe a reply on.',
    prompt: 'Go through the emails I sent and got in the last two weeks. List what I promised to do or still owe a reply on: to whom, what, and since when, the most overdue first. Don’t send anything.',
    schedule: { kind: 'weekly', time: '09:00', day: 1 }, needs: ['zapier'], apps: 'Gmail, through Zapier' },
  { id: 'receipts', title: 'Receipts into a spreadsheet', blurb: 'Attach receipts; get back a spreadsheet with totals.',
    prompt: 'Read the attached receipts and put them in a spreadsheet: date, shop or company, what it was for, amount, currency and tax, with a total for each currency. Send it back to me as a .csv file, which Excel and Google Sheets open.',
    attach: true, needs: [], apps: 'the receipts you attach (PDFs or photos)' }
]
const BLANK = /\{[^{}\n]{1,40}\}/g
const RECIPE_BLANKS = new Set(RECIPES.flatMap((r) => (r.title + r.prompt).match(BLANK) || []))
function hasApp (name, agent) { // connected for this agent, and signed in
  const c = STATE.connectors.find((x) => x.name === name)
  return !!c && !c.broken && (!c.agents || c.agents === 'all' || c.agents.split(/[ ,]+/).includes(agent))
}
// What a recipe may need: an app (for this agent), or the web. Claude Code searches the web on its own; the others
// read it best with their web browser (Apps).
const NEEDS = {
  zapier: { label: 'Zapier', has: (a) => hasApp('zapier', a) },
  github: { label: 'GitHub', has: (a) => hasApp('github', a) },
  browser: { label: 'the web browser', has: (a) => hasApp('browser', a) },
  web: { label: 'the web browser', has: (a) => a === 'claude' || hasApp('browser', a) }
}
function blanked (text) { return text.split(/(\{[^{}\n]{1,40}\})/).map((p, i) => i % 2 ? h('mark', { class: 'blank' }, p) : p) }   // {blanks} marked
function blanksLeft (text) { return (text.match(BLANK) || []).filter((b) => RECIPE_BLANKS.has(b)) }
function pickBlank (ta) { // select the first blank still to fill in, so typing replaces it; false if there's none
  const b = blanksLeft(ta.value)[0]
  if (!b) return false
  const i = ta.value.indexOf(b)
  ta.focus()
  ta.setSelectionRange(i, i + b.length)
  return true
}
function recipeTiles (a, where) { // where: 'chat' (fills in the message) or 'schedule' (adds the task, or fills in the form)
  return h('div', { class: 'recipes' }, RECIPES.filter((r) => where === 'chat' || r.schedule).map((r) => {
    const missing = r.needs.filter((n) => !NEEDS[n].has(a.name))
    const blanks = blanksLeft(r.prompt).length
    return h('div', { class: 'recipe' },
      h('b', {}, blanked(r.title)), h('p', {}, r.blurb),
      h('span', { class: 'small muted' }, 'Uses ' + r.apps + (where === 'schedule' ? ' · ' + cronText(cronOf(r.schedule.kind, r.schedule.time, r.schedule.day)) : '')),
      missing.length ? h('a', { class: 'btn sm', href: '#apps' }, `Connect ${NEEDS[missing[0]].label} first`) : h('button', {
        type: 'button', class: 'btn sm', onclick: (e) => useRecipe(a, r, where, e.currentTarget), 'aria-label': (where === 'chat' ? 'Use: ' : 'Add: ') + r.title
      }, icon('plus'), where === 'chat' ? (r.attach ? 'Use, and attach' : 'Use') : blanks ? 'Fill in and add' : 'Add'))
  }))
}
async function useRecipe (a, r, where, button) {
  if (where === 'chat') {
    const C = CHAT
    if (!C || C.agent !== a.name) return
    recipesBy(C, false)
    C.ta.value = r.prompt
    grow(C.ta)
    blanksHint(C)
    if (!pickBlank(C.ta)) C.ta.focus()
    if (r.attach) C.form.querySelector('input[type=file]').click()
    return
  }
  const sched = r.schedule
  if (blanksLeft(r.prompt).length) { // the form, filled in, with the blank to fill selected
    SCHED[a.name].draft = { prompt: r.prompt, title: r.title, needs: r.needs }
    const set = (k, v) => { const el = document.querySelector(`[data-keep="${k}"]`); if (el) { el.value = v; el.dispatchEvent(new Event('kept')) } }
    set('sched-kind', sched.kind)
    set('sched-time', sched.time)
    set('sched-day', String(sched.day ?? 1))
    set('sched-what', r.prompt)
    const ta = document.querySelector('[data-keep="sched-what"]')
    if (ta) { ta.scrollIntoView({ block: 'center' }); pickBlank(ta) }
    return
  }
  if (!(await addUnwatched(a, r))) return
  // as it is: the same task the form below would add (cc-connect's cron, through the agent's VM)
  const expr = cronOf(sched.kind, sched.time, sched.day)
  button.disabled = true   // (once: a second click would add it twice)
  try {
    await cronApi(a.name, 'POST', '/api/v1/cron', { project: a.name, session_key: 'app:you:you', cron_expr: expr, prompt: r.prompt, description: r.title })
    toast(`Added: ${r.title}, ${cronText(expr).replace(/^Every/, 'every')}.`, 'ok')
    SCHED[a.name].jobs = null
    render(true)
  } catch (e) { toast('Couldn’t add it: ' + e.message) }
  button.disabled = false
}
// A task runs by itself, with nobody watching. One that reads your email (anyone can send you one) on an agent that
// doesn't ask before acting in your apps: what an email says could get it to send or change things there. Say so
// first, and add it only if you still want to. Codex never asks: working read-only (its switch) may not stop it in your
// apps, so it's said for Codex either way. recipe: what it is, when it's one ({title, needs}), else it's what you
// wrote, which may read your email whenever Zapier is there for that agent. → true to add it.
async function addUnwatched (a, recipe) {
  if (a.approve && a.name !== 'codex') return true
  if (recipe ? !recipe.needs.includes('zapier') : !hasApp('zapier', a.name)) return true
  const how = a.name === 'codex'
    ? 'Codex can’t ask before acting in your apps, and working read-only may not stop it there, so an email could get it to send or change something. To be safer, add it to another agent, with “Ask before acting” on.'
    : `${a.label} doesn’t ask before acting in your apps now, so an email could get it to send or change something there. To be safer, turn on “Ask before acting” in its settings first.`
  const what = recipe ? `${recipe.title} runs by itself and reads your email, which anyone can send you.`
    : 'This task runs by itself, with nobody watching, and through Zapier it may read your email, which anyone can send you.'
  return confirmSheet(`${what} ${how}`, 'Add it anyway', 'Not now')
}
function blanksHint (C) { // under the message: what's still to fill in
  const left = blanksLeft(C.ta.value)
  C.hint.replaceChildren(...(left.length ? ['Fill in ', ...left.flatMap((b, i) => [i ? ', ' : '', h('mark', { class: 'blank' }, b)]), ', then send'] : ['Enter to send · Shift+Enter for a new line']))
}

function agentOf (name) { return STATE.agents.find((x) => x.name === name) }
function fileUrl (a, p, dl) { return `/api/chat/${a}/file?p=${encodeURIComponent(p)}${dl ? '&dl=1' : ''}&token=${encodeURIComponent(TOKEN)}` }
const isPicture = (name) => /\.(png|jpe?g|gif|webp)$/i.test(name || '')

function chatOpen (a) {
  if (CHAT && CHAT.agent === a) return CHAT
  chatClose()
  const C = { agent: a, offset: 0, previews: new Map(), shared: [], waking: false, attached: [], connected: null, lastWho: '', asking: null }
  C.list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with ' + nameOf(a) })
  C.typing = h('div', { class: 'typing', hidden: true }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', {}, nameOf(a) + ' is working…'),
    h('button', { type: 'button', class: 'btn sm ghost', title: 'Stop it (Esc)', onclick: () => chatSend(C, '/stop') }, icon('square'), 'Stop'))
  C.empty = h('div', { class: 'chat-empty' },
    h('p', { class: 'chat-hello' }, 'What can ', nameOf(a), ' do for you?'),
    h('div', { class: 'starters' }, STARTERS.map(([t, text]) => h('button', { type: 'button', class: 'starter', onclick: () => { C.ta.value = text; C.ta.focus(); grow(C.ta) } }, t))),
    h('p', { class: 'small muted' }, 'Attach files with the paperclip, or drop them here. It works on its own computer, so it can’t see yours unless you send something.'),
    C.recipes = h('div', { class: 'recipes-wrap' }))
  C.ta = h('textarea', { rows: 1, placeholder: 'Message ' + nameOf(a) + '…', 'aria-label': 'Message ' + nameOf(a) })
  C.chips = h('div', { class: 'attached' })
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { attach(C, picker.files); picker.value = '' } })
  C.sendBtn = h('button', { type: 'submit', class: 'send', 'aria-label': 'Send', title: 'Send (Enter)', disabled: DOWN }, icon('arrow-up'))
  // the recipes, by the message box once the chat isn't empty any more (an empty one shows them itself)
  C.recipePanel = h('div', { class: 'chat-recipes', id: 'chat-recipes', hidden: true })
  C.recipeBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Start from a recipe', 'aria-label': 'Recipes', 'aria-expanded': 'false', 'aria-controls': 'chat-recipes', hidden: true,
    onclick: () => recipesBy(C, C.recipePanel.hidden) }, icon('list-checks'))
  C.form = h('form', { class: 'composer chat-composer' }, C.chips, C.ta, h('div', { class: 'composer-bar' },
    h('button', { type: 'button', class: 'icon-btn', title: 'Attach files', 'aria-label': 'Attach files', onclick: () => picker.click() }, icon('paperclip')), picker, C.recipeBtn,
    C.hint = h('span', { class: 'grow small muted hint' }, 'Enter to send · Shift+Enter for a new line'), C.sendBtn))
  C.form.addEventListener('submit', (e) => { e.preventDefault(); chatSend(C) })
  C.ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(C) } })
  C.ta.addEventListener('input', () => { grow(C.ta); if (C.hint.querySelector('mark') || blanksLeft(C.ta.value).length) blanksHint(C) })
  C.ta.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); attach(C, fs) } })
  C.banner = h('div', { class: 'chat-banner', hidden: true })
  C.el = h('div', { class: 'chat' }, C.empty, C.list, C.typing, h('div', { class: 'chat-dock' }, C.banner, C.recipePanel, C.form))
  C.el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); C.el.classList.add('drop') } })
  C.el.addEventListener('dragleave', (e) => { if (!C.el.contains(e.relatedTarget)) C.el.classList.remove('drop') })
  C.el.addEventListener('drop', (e) => { e.preventDefault(); C.el.classList.remove('drop'); attach(C, e.dataTransfer.files) })
  const draft = DRAFTS[a]   // what you wrote here and didn't send, before you looked at another agent
  if (draft) {
    delete DRAFTS[a]
    C.ta.value = draft.text
    C.attached = draft.attached
    drawAttached(C)
    requestAnimationFrame(() => { grow(C.ta); if (blanksLeft(C.ta.value).length) blanksHint(C) })   // (once it's on the page)
  }
  CHAT = C
  chatLoad(C)
  return C
}
function recipesBy (C, show) { // the recipes by the message box: shown (drawn afresh: what's connected may have changed), or not
  C.recipePanel.hidden = !show
  C.recipeBtn.setAttribute('aria-expanded', String(show))
  const a = agentOf(C.agent)
  if (!show || !a) return
  C.recipePanel.replaceChildren(h('div', { class: 'recipes-head' }, h('p', { class: 'recipes-title' }, 'Start from a recipe'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close the recipes', onclick: () => { recipesBy(C, false); C.recipeBtn.focus() } }, icon('x'))), recipeTiles(a, 'chat'))
}
// What you wrote to an agent and didn't send yet stays its own while you look at another one (in this page only):
// the text, and the files that finished going up
const DRAFTS = {}
function chatClose () {
  if (!CHAT) return
  const attached = CHAT.attached.filter((f) => !f.uploading && f.path)
  if (CHAT.ta.value.trim() || attached.length) DRAFTS[CHAT.agent] = { text: CHAT.ta.value, attached }
  clearTimeout(CHAT.retry)
  CHAT = null
}
function grow (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px' }
async function chatLoad (C, again) { // the end of the conversation; what comes next arrives on the live stream
  if (again) { C.loaded = false; C.waiting = [] }   // read it all again (a new log): lines that arrive meanwhile wait
  let d
  try {
    d = await api(`/api/chat/${C.agent}/history?tail=600000`)
    if (CHAT !== C) return
  } catch (e) { if (CHAT === C) C.retry = setTimeout(() => chatLoad(C, again), 3000); return }
  const near = nearEnd()
  C.list.replaceChildren()
  C.asking = null
  C.previews.clear()
  C.shared = []
  C.lastWho = ''
  if (d.more) add(C, h('div', { class: 'chat-divider earlier' }, h('span', {}, 'Earlier messages aren’t shown here')), '')
  for (const e of d.entries) chatAdd(C, e, true)
  C.offset = d.o
  LIVE.offsets[C.agent] = Math.max(LIVE.offsets[C.agent] ?? -1, d.o)
  if (looking(C.agent)) saw(C.agent)
  C.loaded = true
  for (const w of C.waiting || []) chatLive(C, w)   // what the live stream brought while this was loading
  C.waiting = []
  drawChatState(C)
  if (!again || near) scrollEnd(true)
  liveConnect()
}
function chatLive (C, d) { // a new line in the open chat
  if (!C.loaded) { (C.waiting = C.waiting || []).push(d); return }
  if (d.o <= C.offset) return
  C.offset = d.o
  const near = nearEnd()
  chatAdd(C, d.e, false)
  drawChatState(C)
  if (near || d.e.t === 'you') scrollEnd()
}
function nearEnd () { return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160 }
function scrollEnd (instant) { requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: instant ? 'auto' : 'smooth' })) }

function chatAdd (C, e, history) {
  if ((e.session || 'you') !== 'you') return
  const recent = Date.now() - (e.at || 0) < 10 * 60 * 1000
  switch (e.t) {
    case 'you': {
      C.typing.hidden = history && !recent
      const text = (e.text || '').trim()
      if (text === '/new' || text === '/reset') { add(C, h('div', { class: 'chat-divider' }, h('span', {}, 'New conversation')), ''); break }
      if (text === '/stop') { add(C, h('div', { class: 'chat-divider' }, h('span', {}, 'You stopped it')), ''); break }
      for (const f of e.files || []) C.shared.push({ ...f, from: 'you', at: e.at })
      add(C, h('div', { class: 'msg-you' }, h('div', { class: 'bubble' },
        (e.files || []).length ? h('div', { class: 'bubble-files' }, e.files.map((f) => fileChip(C.agent, f))) : null,
        text ? (text.startsWith('/') ? h('code', {}, text) : h('div', { class: 'md plain' }, text)) : null),
      h('time', {}, clock(e.at))), 'you')
      break
    }
    case 'preview': { // still being written: a screen reader waits for it (aria-busy) instead of reading it out at every update
      const m = agentMsg(C, md(e.text || '…'), 'streaming', e.at)
      m.dataset.ctx = e.ctx || ''
      m.setAttribute('aria-busy', 'true')
      C.previews.set(e.handle, m)
      add(C, m, 'agent')
      break
    }
    case 'update': { const m = C.previews.get(e.handle); if (m) m.querySelector('.agent-body').replaceChildren(md(e.text || '')); break }
    case 'delete': { const m = C.previews.get(e.handle); if (m) { m.remove(); C.previews.delete(e.handle); whoLast(C) } break }
    case 'reply':
      for (const [k, m] of C.previews) if (!e.ctx || m.dataset.ctx === e.ctx) { m.remove(); C.previews.delete(k) }
      whoLast(C)
      C.typing.hidden = true
      add(C, agentMsg(C, md(e.text || ''), '', e.at, e.text), 'agent')
      break
    case 'buttons': C.typing.hidden = true; settled(C); add(C, buttonsMsg(C, e), 'agent'); break
    case 'card': C.typing.hidden = true; add(C, agentMsg(C, cardOf(C, e.card), 'card-msg', e.at), 'agent'); break
    case 'file':
      C.shared.push({ ...e, from: 'agent' })
      add(C, agentMsg(C, h('div', { class: 'bubble-files' }, fileChip(C.agent, e)), '', e.at), 'agent')
      break
    case 'typing': C.typing.hidden = !e.on || (history && !recent); break
    case 'action': {
      const q = [...C.list.querySelectorAll('.choices:not(.is-answered)')].reverse().find((el) => (el.dataset.values || '').split('\n').includes(e.action))
      if (q) answered(q, e.label || e.action)
      break
    }
    case 'error': C.typing.hidden = true; settled(C); add(C, h('div', { class: 'chat-note bad' }, icon('circle-alert'), sentence(e.text || 'Something went wrong')), ''); break
    case 'status': C.connected = e.connected; break
  }
  if (e.ends) over(C, e.t === 'you' && !String(e.text || '').trim().startsWith('/') ? 'You answered it in a message.' : '')
}
function settled (C) { // what was being written stays as it is (cc-connect keeps it when it stops to ask, or on an error)
  for (const m of C.previews.values()) { m.removeAttribute('aria-busy'); m.classList.remove('streaming') }
}
function whoLast (C) { // who spoke last, once a preview is gone
  const last = C.list.lastElementChild
  C.lastWho = !last ? '' : last.classList.contains('msg-agent') ? 'agent' : last.classList.contains('msg-you') ? 'you' : ''
}
function add (C, el, who) {
  C.list.append(el)
  C.lastWho = who
}
function clock (t) { return t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '' }
function agentMsg (C, body, cls, at, text) { // text: an answer's own words, to copy or save
  const first = C.lastWho !== 'agent'
  return h('div', { class: 'msg-agent' + (cls ? ' ' + cls : '') + (first ? ' first' : '') },
    first ? h('div', { class: 'agent-who' }, avatar(C.agent, 20), h('b', {}, nameOf(C.agent)), at ? h('time', {}, clock(at)) : null) : null,
    h('div', { class: 'agent-body' }, body),
    text ? h('div', { class: 'msg-tools' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Copy', 'aria-label': 'Copy this answer', onclick: (e) => copyAnswer(text, e.currentTarget) }, icon('copy')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Save as a file', 'aria-label': 'Save this answer as a file', onclick: () => saveAnswer(C.agent, text, at) }, icon('download'))) : null)
}
async function copyAnswer (text, button) { // with its formatting (a list stays a list in Word or an email), and as plain text
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([md(text).outerHTML], { type: 'text/html' }) })])
    } else await navigator.clipboard.writeText(text)
    button.replaceChildren(icon('check'))
    button.setAttribute('aria-label', 'Copied')
    setTimeout(() => { button.replaceChildren(icon('copy')); button.setAttribute('aria-label', 'Copy this answer') }, 1500)
  } catch (e) { toast('Couldn’t copy it: ' + e.message) }
}
function saveAnswer (agent, text, at) { // as a Markdown file: "claude 2026-10-05 0821.md"
  const d = new Date(at || Date.now())
  const two = (n) => String(n).padStart(2, '0')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const link = h('a', { href: url, download: `${agent} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}.md` })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
function fileChip (a, f) {
  const name = f.name || (f.path || '').split('/').pop()
  if (isPicture(name) && f.path) {
    return h('a', { class: 'pic', href: fileUrl(a, f.path), target: '_blank', rel: 'noopener', title: name }, h('img', { src: fileUrl(a, f.path), alt: name, loading: 'lazy' }))
  }
  return h('a', { class: 'file-chip', href: f.path ? fileUrl(a, f.path, true) : null, download: name }, h('span', { class: 'file-ic' }, icon('file-text')),
    h('span', { class: 'grow' }, h('b', {}, name), f.size ? h('span', { class: 'sub' }, size(f.size)) : null), f.path ? icon('download') : null)
}
// Asking before acting, in words. cc-connect (v1.5.0) asks "⚠️ **Permission Request**\n\nAgent wants to use **<tool>**:
// \n\n```\n<input>\n```\n\nReply **allow** / **deny** / **allow all** (skip all future prompts this session)." (or the
// same in one of its other languages), with the buttons perm:allow, perm:deny and perm:allow_all. <input> is the
// command for Bash, the file for Read, Edit and Write, the address for Cursor's WebFetch, and otherwise the tool's
// input as one line of JSON, cut at 800 characters with "...". The card says what the agent would do, shows the
// details that matter first, and keeps exactly what it asked one click away. (1.5.1-beta.3 asks in the same words.)
// perm:allow_all stops all asking in that chat: for every tool and app, the scheduled tasks that run in it too (they
// share its session), until /new. Its button says "everything", not just "this kind of thing".
const PERM_LABEL = { 'perm:allow': 'Allow', 'perm:deny': 'Deny', 'perm:allow_all': 'Allow everything until a new conversation' }
// Zapier's tools are named after the app first: gmail_send_email, google_calendar_find_event…
const ZAPIER_APPS = [['google_calendar', 'Google Calendar'], ['google_sheets', 'Google Sheets'], ['google_docs', 'Google Docs'],
  ['google_drive', 'Google Drive'], ['google_contacts', 'Google Contacts'], ['microsoft_outlook', 'Outlook'], ['microsoft_teams', 'Microsoft Teams'],
  ['microsoft_excel', 'Excel'], ['microsoft_onedrive', 'OneDrive'], ['jira_software_cloud', 'Jira'], ['gmail', 'Gmail'], ['slack', 'Slack'],
  ['notion', 'Notion'], ['hubspot', 'HubSpot'], ['salesforce', 'Salesforce'], ['trello', 'Trello'], ['asana', 'Asana'], ['airtable', 'Airtable'],
  ['dropbox', 'Dropbox'], ['zoom', 'Zoom'], ['calendly', 'Calendly'], ['linkedin', 'LinkedIn'], ['todoist', 'Todoist'], ['docusign', 'DocuSign']]
// The details shown first, with their names in words; then everything else it would send, and the text (a message's
// body, say) last, cut to a few lines
const APPROVAL_FIELDS = [['to', 'To'], ['cc', 'Cc'], ['bcc', 'Bcc'], ['subject', 'Subject'], ['title', 'Title'], ['file_path', 'File'],
  ['notebook_path', 'File'], ['path', 'File'], ['url', 'Address'], ['query', 'Search for'], ['command', 'Command']]
const APPROVAL_BODY = ['body', 'text', 'message', 'content', 'instructions']
// Words to read, drawn as written words are; the rest (what runs, or where it goes) is drawn in the order it's written,
// letter by letter (.exact)
const PROSE = ['subject', 'title', 'instructions']
// Letters written right to left (Hebrew, Arabic and others): drawn as written words are, what's next to them may be
// drawn in another order than it's sent ("Pay invoice א 100 900" shows as "Pay invoice 900 100 א")
const RTL = /(?=[\p{L}\p{N}])[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u
function words (name) { return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[\s_.-]+/g, ' ').trim().toLowerCase() }
function capital (s) { return s ? s[0].toUpperCase() + s.slice(1) : s }
function toolWords (tool, path) { // what a tool does: {what: 'Gmail: send email', via: 'Zapier'}
  const parts = tool.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) { // an app you connected: mcp__<server>__<action>
    const server = parts[1]
    const action = parts.slice(2).join(' ')
    const app = server === 'zapier' && ZAPIER_APPS.find(([p]) => action === p || action.startsWith(p + '_'))
    if (app) return { what: `${app[1]}: ${words(action.slice(app[0].length)) || 'use it'}`, via: 'Zapier' }
    return { what: `${pretty(server)}: ${words(action) || 'use it'}` }
  }
  const file = path ? ': ' + path : ''
  if (/^(Bash|Shell)$/i.test(tool)) return { what: 'Run a command on its own computer' }
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return { what: 'Change a file' + file }
  if (/^(Read|NotebookRead)$/.test(tool)) return { what: 'Read a file' + file }
  if (/^Web(Fetch|Search)$/.test(tool)) return { what: 'Look something up online' }
  return { what: capital(words(tool)) || tool }
}
function looseJSON (text) { // the tool's input as {args, cut, open}: JSON, or JSON that cc-connect cut short ("..."); else null
  const t = text.trim()
  if (!t.startsWith('{')) return null
  const obj = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null } catch (e) { return null } }
  const whole = obj(t)
  if (whole) return { args: whole, cut: false }
  if (!t.endsWith('...')) return null
  // closed off where it was cut (half an escape and a dangling comma dropped first), as far as it goes; and which value
  // that closed off (open): cut right after "cc": or "cc":", it's null or "" only because it was cut there. (Which one
  // that is: the one that changes when it's closed off with something in it instead; for a list cut after an item,
  // "cc":["", one more item in it.)
  const cut = t.slice(0, -3).replace(/\\+$/, (s) => s.length % 2 ? s.slice(1) : s).replace(/,\s*$/, '')
  for (const end of ['"}', '}', '":null}', 'null}', '"]}', ']}', '"}}', '}}', '"}]}']) {
    const o = obj(cut + end)
    if (!o) continue
    const alt = obj(cut + (end.includes('null') ? end.replace('null', '0') : /^["\]]/.test(end) ? '0' + end : end)) ||
      (end[0] === ']' && obj(cut + ',0' + end)) || o
    return { args: o, cut: true, open: Object.keys(o).find((k) => JSON.stringify(o[k]) !== JSON.stringify(alt[k])) }
  }
  return null
}
function shown (v) { // a value as text: a list as "a, b", anything else as JSON. All of it: cc-connect cuts the whole input at
  // 800 characters already, and the end of a command ("… && curl … | sh") is what matters most.
  return typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v)
}
// Tools whose input cc-connect sends as it is, never as JSON (claudecode's summarizeInput: a command, a file, a pattern;
// Codex and Cursor send a command as it is too). A command that looks like JSON is still a command: read as JSON, the
// card would show what a part of it says, not what runs.
const RAW_INPUT = /^(Bash|Shell|Read|Edit|Write|Grep|Glob)$/i
const blank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
// Characters that don't show as what they are: ones that don't show at all (U+200B, U+FEFF, a variation selector),
// control and format characters, ones that turn the text after them around (U+202E), and spaces that aren't the
// space (to a shell, "rm -rf ~/old ~" with U+00A0 for its second space is one word). With one, a command or an
// address can look like it says what it doesn't. Shown as what they are (⟨U+202E⟩), and Home doesn't offer Allow for
// them. So is U+2800, the blank braille pattern, drawn as a space but none. (But for a newline and a tab; and for the
// variation selector that makes a picture an emoji: cc-connect's ⚠️ is ⚠ and U+FE0F. Not after a digit, "#" or "*",
// which are emoji too, to make a keycap: "notes1️.md" isn't "notes1.md".)
const UNSEEN = /(?![\t\n ]|(?<=\p{Extended_Pictographic})[\u{FE0E}\u{FE0F}])[\p{C}\p{Default_Ignorable_Code_Point}\p{Z}\u{2800}]/u
const UNSEEN_ALL = new RegExp(UNSEEN.source, 'gu')
// Letters from another alphabet that look like these: "bob@acme.com" with a Cyrillic "a" (U+0430) is someone else's
// address, and so is one with a Lisu "ꓮ" for its "A", or a Coptic "ⲟ" for its "o": nearly every alphabet has a letter
// or a digit that looks like a Latin one. So in a word with Latin letters, those of any other alphabet are marked,
// "bob@⟨а⟩cme.com", and Home doesn't offer Allow for it. But for Chinese, Japanese and Korean, written next to Latin
// letters in one word all the time ("用Python"), whose letters don't pass for Latin ones; and for what every alphabet
// has (digits 0-9, marks over letters). In a word without Latin letters, it's the same for alphabets whose letters
// look alike (Greek, Cyrillic, Armenian, Cherokee, Coptic, Lisu): those from another than its first are marked. A word
// is letters and digits, with an address's dots and @ between them: one in one alphabet is as it is, and so is a
// Russian word with "IT-" before it (two words).
const ALPHABETS = ['Greek', 'Cyrillic', 'Armenian', 'Cherokee', 'Coptic', 'Lisu'].map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')])
const LATIN = /\p{Script=Latin}/u
const NOT_LATIN = '(?![\\p{Script=Latin}\\p{Script=Common}\\p{Script=Inherited}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Bopomofo}])[\\p{L}\\p{M}\\p{N}]'
const OTHER = new RegExp(NOT_LATIN, 'u')
const OTHERS = new RegExp(`(?:${NOT_LATIN}\\p{M}*)+`, 'gu')
const WORD = /[\p{L}\p{M}\p{N}]+(?:[.@][\p{L}\p{M}\p{N}]+)*/gu
function othersIn (word) { // what finds the letters in a word from another alphabet than its own; null if there are none
  if (LATIN.test(word)) return OTHER.test(word) ? OTHERS : null
  const others = ALPHABETS.filter(([, letter]) => letter.test(word)).slice(1).map(([name]) => `\\p{Script=${name}}`)
  return others.length ? new RegExp(`(?:[${others.join('')}]\\p{M}*)+`, 'gu') : null
}
const mixesAlphabets = (s) => (String(s).match(WORD) || []).some((word) => othersIn(word))
function visible (s) { // what it asks as it's shown, wherever it is: what doesn't show as what it is, marked
  return String(s).replace(WORD, (word) => { const others = othersIn(word); return others ? word.replace(others, '⟨$&⟩') : word })
    .replace(UNSEEN_ALL, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`)
}
function approvalOf (text) { // {raw, tool, what, via, fields: [[label, value, key]], body, cut, unseen, mixed, alike}; what is '' if it isn't cc-connect's prompt
  const raw = String(text || '')
  const fence = /```[^\n`]*\n?([\s\S]*)```/.exec(raw)
  const bold = fence && [...raw.slice(0, fence.index).matchAll(/\*\*([^*\n]+)\*\*/g)].pop()   // the tool: the last bold before it
  if (!bold) return { raw, tool: '', what: '', fields: [], body: '', keys: [], unseen: UNSEEN.test(raw), mixed: mixesAlphabets(raw), alike: false }
  const tool = bold[1].trim()
  const input = fence[1].replace(/\n$/, '')
  const parsed = RAW_INPUT.test(tool) ? null : looseJSON(input)
  const args = parsed ? parsed.args : {}
  if (!parsed && input) { // not JSON: a command, a file or an address
    if (/^(Bash|Shell)$/i.test(tool)) args.command = input
    else if (/^Web(Fetch|Search)$/.test(tool)) args[/^https?:\/\//.test(input) ? 'url' : 'query'] = input
    else if (/^(Write|Edit|MultiEdit|Read|NotebookEdit|NotebookRead)$/.test(tool)) args.path = input
    else args.input = input
  }
  // its file, in what it does (of two, which would that be? Both are shown, below)
  const paths = ['file_path', 'notebook_path', 'path'].filter((k) => typeof args[k] === 'string' && args[k])
  const { what, via } = toolWords(tool, paths.length === 1 ? args[paths[0]] : '')
  const inWhat = /^(Change|Read) a file:/.test(what) ? paths[0] : ''
  const bodyKey = APPROVAL_BODY.find((k) => typeof args[k] === 'string' && args[k].trim())
  const known = (k) => APPROVAL_FIELDS.some(([f]) => f === k)
  // Each field it sends, an empty one too ("cc": "", null or []: it's on no line, so Home offers no Allow for it, and
  // the card shows why), as "" (which the card says is empty); but for one that would say so only because it was cut
  // there ([""] too, which shows as "")
  const said = (v) => blank(v) ? '' : shown(v)
  const sent = (k) => Object.prototype.hasOwnProperty.call(args, k) && !(k === (parsed && parsed.open) && said(args[k]) === '')
  const fields = APPROVAL_FIELDS.filter(([k]) => sent(k) && k !== inWhat).map(([k, label]) => [label, said(args[k]), k])
  for (const [k, v] of Object.entries(args)) { // everything else it would send: nothing is left out
    if (k !== bodyKey && !known(k) && sent(k)) fields.push([capital(words(k)) || JSON.stringify(k), said(v), k])   // (a name of no letters, "" say, as sent)
  }
  // Names that read alike ("TO" next to "to", two files, or a name like one of the card's own, "Command"): the app it
  // goes to may use either one, so each is shown with its name as it was sent ("TO"), and Home doesn't offer Allow
  const own = new Set(APPROVAL_FIELDS.map(([, label]) => label.toLowerCase()))
  const named = {}
  for (const name of [...fields.map(([label]) => label.toLowerCase()), bodyKey && words(bodyKey)]) if (name) named[name] = (named[name] || 0) + 1
  const alike = fields.filter(([label, , k]) => named[label.toLowerCase()] > 1 || (!known(k) && own.has(label.toLowerCase())))
  for (const f of alike) f[0] = JSON.stringify(f[2])
  // (cut by cc-connect: JSON closed off where it was cut, or input as it is that's 800 characters and "...")
  const cut = parsed ? parsed.cut : [...input].length === 803 && input.endsWith('...')
  const body = bodyKey ? args[bodyKey] : ''
  // (in what it asked, or in what's read from its JSON: Go writes U+2028 and the control characters there as \u2028)
  const all = [raw, body, ...fields.flatMap(([, v, k]) => [k, v])]
  // (words to read, written partly right to left: the text, a subject, a title, instructions)
  const rtl = [body, ...fields.filter(([, , k]) => PROSE.includes(k)).map(([, v]) => v)].some((s) => RTL.test(s))
  // (a file to write or change, of which cc-connect sends only the name: not what it would write)
  const blind = /^(Write|Edit)$/i.test(tool)
  return { raw, tool, what, via, fields, body, bodyKey, inWhat, keys: Object.keys(args), cut, unseen: all.some((s) => UNSEEN.test(s)), mixed: all.some(mixesAlphabets), alike: alike.length > 0, rtl, blind }
}
// In one line, for Home and notifications: "Gmail: send email to bob@acme.com"; all: not cut. (Marked first: a
// U+FEFF or U+2028 is a space to \s, and then a space is all it would show.) A question not in cc-connect's words is
// as it is, but for its bold ("**delete**"): its "*", ">" and "`" may be what runs.
function approvalLine (ap, all) {
  if (!ap.what) return visible(ap.raw.replace(/\*\*([^*\n]+)\*\*/g, '$1')).replace(/[\t\n ]+/g, ' ').trim().slice(0, 160)
  const line = lineParts(ap).map(([t]) => t).join('')
  return all || line.length <= 160 ? line : line.slice(0, 159) + '…'
}
// ...in parts, each marked and on one line: [text, words to read], what it does first
function lineParts (ap) { return [[ap.what, false], ...moreOf(ap).parts].map(([t, prose]) => [visible(t).replace(/[\t\n ]+/g, ' '), prose]) }
function approvalMore (ap) { return moreOf(ap).parts.map(([t]) => t).join('') }
// What the line says after what it does: who it goes to (all of them), or else what it runs, opens, looks for or is
// about. After whoever it goes to: Zapier's instructions, the words its AI acts on, or else the subject ("to
// bob@acme.com, subject: Lunch on Friday"). As parts, [text, words to read (a subject, a title, instructions) or
// not], with the names of what it asks that they show.
const ON_LINE = ['command', 'url', 'file_path', 'notebook_path', 'path', 'query', 'subject', 'title', 'instructions', 'input']
function moreOf (ap) {
  const f = Object.fromEntries(ap.fields.map(([, v, k]) => [k, v]))
  if (ap.bodyKey) f[ap.bodyKey] = ap.body
  const to = [['to', ''], ['cc', 'cc '], ['bcc', 'bcc ']].filter(([k]) => f[k])
  const k = to.length ? (f.instructions ? 'instructions' : f.subject ? 'subject' : '') : ON_LINE.find((x) => f[x])
  const parts = to.length ? [[' to ' + to.map(([x, w]) => w + f[x]).join(', '), false]] : []
  if (k) parts.push([(to.length && k === 'subject' ? ', subject: ' : ': ') + f[k], PROSE.includes(k)])
  return { parts, keys: [...to.map(([x]) => x), k].filter(Boolean) }
}
// Is that line all it asks, as far as saying yes goes? Only when it shows all of what it would send: every field, by
// name. None may be left off: each is something the app acts on, and what it does may hang on any of them (an email's
// body, a calendar event's guests, a search's limit). An app may read words in any field as what to do, as Zapier's
// tools read their instructions, filling in from them whatever they weren't given. Nor is an empty one left off
// ("assignees": [] can take everyone off an issue). And not when it isn't cc-connect's question, when cc-connect cut
// what it asks (an email's "to" comes after its body, and may be in the part cut off), when the line is cut (the end
// of a command is what matters), when it puts a command's lines on one (each one runs), or when what it asks has
// characters that don't show, letters from another alphabet that look like these, or names that read alike; nor when
// words on it are written partly right to left (Home draws them as written words are, and what's next to them, a
// number say, may be drawn in another order than it's sent: the card has it in order). Nor for a file to write or
// change, of which cc-connect sends only the name: what it would write in it is in no request. Nor when
// it's as long as what Home has of it: server.py's activity() keeps the first 4,000 characters, and a "```" in a
// longer one would end what Home reads of it there.
function approvalWhole (ap) {
  const shown = new Set([ap.inWhat, ...moreOf(ap).keys].filter(Boolean))   // ("": nothing; not a field named "")
  return !!ap.what && !ap.cut && !ap.unseen && !ap.mixed && !ap.alike && !ap.rtl && !ap.blind && [...ap.raw].length < 4000 &&
    approvalLine(ap, true).length <= 160 && !/\n/.test(approvalMore(ap)) && ap.keys.every((k) => shown.has(k))
}
function approvalView (ap) { // what the card shows above its buttons
  const odd = [ // (why Home offers no Allow for it, where that's in what it asks)
    ap.unseen && 'This has characters that don’t show, or don’t show as what they are. They can make it look like it does something it doesn’t. They’re marked like ⟨U+202E⟩.',
    ap.mixed && 'Some words in this mix letters from different alphabets that look alike. An address can look like one you know and be someone else’s. The letters from another alphabet are marked like ⟨\u{430}⟩.',
    ap.alike && 'Some names in this read the same, like “to” and “TO”. The app may use either one, so each is shown with the name it was sent with.',
    ap.blind && 'It doesn’t say what it would write in the file, only which file it is.',
    ap.rtl && 'Some of the words in this are written right to left, as Hebrew and Arabic are, so what’s next to them, a number say, may be drawn in another order than it’s sent. Exactly what it asked, at the end, has all of it in the order it’s sent.'
  ].filter(Boolean).map((text) => h('p', { class: 'note warn' }, icon('triangle-alert'), text))
  if (!ap.what) return [...odd, h('pre', { class: 'approval-text exact' }, visible(ap.raw.replace(/\n*Reply \*\*allow\*\*[^\n]*$/, '').trim()))]
  const clamp = h('div', { class: 'clamp' }, visible(ap.body))
  const body = ap.body ? h('div', { class: 'approval-body' }, clamp) : null
  const more = body && h('button', { type: 'button', class: 'linkish approval-more', 'aria-expanded': 'false', hidden: true, onclick: (e) => { const open = body.classList.toggle('open'); e.currentTarget.textContent = open ? 'Show less' : 'Show all'; e.currentTarget.setAttribute('aria-expanded', String(open)) } }, 'Show all')
  // "Show all" when the text is cut, which only its laid-out lines can tell (a long line takes two, a narrow window more)
  if (more) new ResizeObserver(() => { if (!body.classList.contains('open')) more.hidden = clamp.scrollHeight <= clamp.clientHeight + 1 }).observe(clamp)
  return [
    h('p', { class: 'approval-what' }, h('b', {}, ap.what), ap.via ? h('span', { class: 'muted small' }, ' through ' + ap.via) : null),
    ...odd,
    // (an empty one says so, in words of the card's own: not what it sent, which could say "(empty)" itself)
    ap.fields.length ? h('dl', { class: 'approval-fields' }, ap.fields.map(([label, v, k]) => h('div', {}, h('dt', {}, visible(label)),
      v === '' ? h('dd', { class: 'empty' }, '(empty)') : h('dd', PROSE.includes(k) ? {} : { class: 'exact' }, visible(v))))) : null,
    body,
    more,
    ap.cut ? h('p', { class: 'small muted' }, 'Only the start of this was shown here. Allow lets it do all of it.') : null,
    h('details', { class: 'approval-raw' }, h('summary', {}, 'Exactly what it asked'), h('pre', { class: 'exact' }, visible(ap.raw)))
  ]
}
// Buttons in the chat: a question from the agent, or asking before it acts (cc-connect's "perm:" buttons). cc-connect's
// buttons say allow or deny, not to what, so an answer from a card goes with the approval it shows: what it asked and
// when, as its line in the log says them (cut as server.py's approval() cuts them: the first 4,000 characters, counted
// by code point as Python counts them, not in UTF-16 units as slice() would). The server sends it only while that's
// the approval the agent waits for. Only the newest one waits, until a line ends the wait ("ends", as server.py reads
// it: a message that answers it, /stop, /new, cc-connect restarted); then its card says so, and offers nothing.
function buttonsMsg (C, e) {
  const all = (e.buttons || []).flat()
  const perm = all.some((b) => /^perm:/.test(b.data))
  const box = h('div', { class: 'choices' + (perm ? ' approval' : '') })
  box.dataset.values = all.map((b) => b.data).join('\n')
  const body = perm ? [h('div', { class: 'approval-head' }, icon('hand'), h('b', {}, nameOf(C.agent) + ' wants your OK')), approvalView(approvalOf(e.text))]
    : [md(e.text || '')]
  const pending = perm ? { text: [...String(e.text || '')].slice(0, 4000).join(''), at: e.at ?? null } : undefined
  box.pending = pending
  box.append(...body.flat().filter(Boolean), h('div', { class: 'choice-row' }, (e.buttons || []).map((row) => row.map((b) => {
    const label = (perm && PERM_LABEL[b.data]) || b.text
    return h('button', { type: 'button', class: 'btn sm' + (/allow$/.test(b.data) ? ' primary' : ''), onclick: () => choose(C, box, b.data, label, pending) }, label)
  }))))
  if (perm) { over(C); C.asking = box }   // (one asked before it isn't waited for any more)
  return agentMsg(C, box, '', e.at)
}
function choose (C, box, value, label, pending) {
  const row = box.querySelector('.choice-row')
  answered(box, label)
  api(`/api/chat/${C.agent}/action`, { method: 'POST', body: { action: value, label, pending } }).catch((err) => {
    if (err.status === 409 && pending) { // the agent has moved on, it was answered already, or its VM stopped: nothing was sent
      if (/^It stopped/.test(err.message)) forgot(C.agent, pending)   // (for good, and on Home too)
      answered(box, '', /^You answered/.test(err.message) ? 'You answered it already.' : /^It stopped/.test(err.message) ? stoppedWaiting(C.agent)
        : nameOf(C.agent) + ' isn’t waiting for this any more.')
      return
    }
    // it didn't go (cage isn't answering, say): its buttons again, to answer once it can
    box.classList.remove('is-answered')
    const chosen = box.querySelector('.chosen')
    if (row && chosen) chosen.replaceWith(row)
    box.querySelectorAll(ANSWERS).forEach((b) => { b.disabled = false })
    drawAsking(C)   // (unless its agent isn't up any more)
    toast(err.message)
  })
}
// cc-connect forgets an approval when it stops (asleep, say), and drops an answer to one it forgot without a word: so
// while its agent isn't up, the card that waits offers no answers, and says why, as Home offers none (askingOf). Up
// again, it offers them only if its VM didn't stop meanwhile (it only looked away: cage's state said it was signing
// in, say): one it was waiting for while its VM wasn't running, it never offers again (forgotten()).
// (server.py refuses an answer while the agent's VM isn't running, for when this page doesn't know yet.)
function stoppedWaiting (agent) { return nameOf(agent) + ' stopped while waiting for your OK, so it won’t go ahead.' }
function drawAsking (C) {
  const box = C.asking
  if (!box || box.classList.contains('is-answered')) return
  const a = agentOf(C.agent)
  const row = box.querySelector('.choice-row')
  const note = box.querySelector('.chosen')
  if (forgotten(C.agent, box.pending)) answered(box, '', stoppedWaiting(C.agent))
  else if (a && a.state === 'ready') { if (note && note.row) note.replaceWith(note.row) }
  else if (row) row.replaceWith(Object.assign(h('div', { class: 'chosen over' }, icon('info'), stoppedWaiting(C.agent)), { row }))   // (its buttons kept for then)
}
// What a card says once it's answered (what you chose), or once it can't be (why), instead of its buttons. Only its
// answers are off: what it shows can still be read (an email's body, with Show all)
const ANSWERS = '.choice-row button, .list-item button'
function answered (box, label, why) {
  box.classList.add('is-answered')
  box.querySelectorAll(ANSWERS).forEach((b) => { b.disabled = true })
  const row = box.querySelector('.choice-row, .chosen')
  if (row) row.replaceWith(why ? h('div', { class: 'chosen over' }, icon('info'), why) : h('div', { class: 'chosen' }, icon('check'), 'You chose: ', h('b', {}, label.replace(/^[^\p{L}\p{N}]+/u, ''))))
}
// The approval card that waited no longer does (answered, ended, or asked anew): it says so, if nothing answered it here
function over (C, why) {
  const box = C.asking
  C.asking = null
  if (box && !box.classList.contains('is-answered')) answered(box, '', why || nameOf(C.agent) + ' isn’t waiting for this any more.')
}
// cc-connect's cards (/help, /usage, model pickers…): headers, text, notes and buttons
function cardOf (C, card) {
  const box = h('div', { class: 'card-box choices' })
  const values = []
  const b = (text, value, kind) => { values.push(value); return h('button', { type: 'button', class: 'btn sm' + (kind === 'primary' ? ' primary' : ''), onclick: () => choose(C, box, value, text) }, text) }
  if (card && card.header && card.header.title) box.append(h('div', { class: 'card-title' }, card.header.title))
  for (const el of (card && card.elements) || []) {
    if (el.type === 'markdown') box.append(md(el.content || ''))
    else if (el.type === 'divider') box.append(h('hr'))
    else if (el.type === 'note') box.append(h('p', { class: 'small muted' }, el.text || ''))
    else if (el.type === 'actions') box.append(h('div', { class: 'choice-row' }, (el.buttons || []).map((x) => b(x.text, x.value, x.btn_type))))
    else if (el.type === 'list_item') box.append(h('div', { class: 'list-item' }, h('span', { class: 'grow' }, el.text || ''), el.btn_value ? b(el.btn_text || 'Choose', el.btn_value, el.btn_type) : null))
    else if (el.type === 'select') {
      const sel = h('select', { onchange: () => sel.value && choose(C, box, sel.value, sel.selectedOptions[0].textContent) },
        h('option', { value: '' }, el.placeholder || 'Choose…'), (el.options || []).map((o) => { values.push(o.value); return h('option', { value: o.value }, o.text) }))
      box.append(h('div', { class: 'choice-row' }, sel))
    }
  }
  box.dataset.values = values.join('\n')
  if (!values.length) box.classList.add('is-answered')
  return box
}

async function attach (C, files) {
  for (const f of [...files]) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is bigger than 25 MB, so it can’t be sent.`); continue }
    const item = { name: f.name, uploading: true }
    C.attached.push(item)
    drawAttached(C)
    try {
      const res = await fetch(`/api/chat/${C.agent}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Cage-Token': TOKEN }, body: f })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || res.statusText)
      Object.assign(item, d, { uploading: false })
    } catch (e) { C.attached.splice(C.attached.indexOf(item), 1); toast(`Couldn’t attach ${f.name}: ${e.message}`) }
    drawAttached(C)
  }
}
function drawAttached (C) {
  C.chips.replaceChildren(...C.attached.map((f) => h('span', { class: 'chip' + (f.uploading ? ' busy' : '') }, f.uploading ? h('span', { class: 'spinner' }) : icon(isPicture(f.name) ? 'image' : 'paperclip'), f.name,
    h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove ' + f.name, onclick: () => { C.attached.splice(C.attached.indexOf(f), 1); drawAttached(C) } }, icon('x')))))
}
// What you wrote, with the files you attached; or `text` (a command: /stop, /new) on its own, which leaves what you're
// writing as it is. With a picture, cc-connect wouldn't even read "/stop" as a command: it would go to the agent.
async function chatSend (C, text) {
  const a = agentOf(C.agent)
  const msg = text !== undefined ? text : C.ta.value
  const files = text === undefined ? C.attached.filter((f) => !f.uploading && f.path) : []
  if (!msg.trim() && !files.length) return
  if ((text === undefined && C.attached.some((f) => f.uploading)) || DOWN) return
  if (text === undefined && pickBlank(C.ta)) { toast(`Fill in ${blanksLeft(msg)[0]} first.`, 'info'); return }
  if (!a.enabled || a.state === 'login') { drawChatState(C, true); return }
  try {
    await api(`/api/chat/${C.agent}/send`, { method: 'POST', body: { text: msg, files: files.map(({ path, name, mime }) => ({ path, name, mime })) } })
  } catch (e) { toast(e.message); return }
  if (text === undefined) { C.ta.value = ''; grow(C.ta); C.attached = []; drawAttached(C); blanksHint(C) }
  C.typing.hidden = false
  if (['asleep', 'none'].includes(a.state) && !C.waking) wake(C)   // it waits in its folder until the agent is up
  drawChatState(C)
}
async function wake (C) { // wake the chat's agent up, and say so if that doesn't work
  C.waking = true
  C.woke = null
  drawChatState(C)
  try {
    const { id } = await api('/api/jobs', { method: 'POST', body: { args: ['up', C.agent] } })
    watch(id, (ev) => {
      if (ev.t !== 'exit' && ev.t !== 'gone') return
      if (ev.code || ev.t === 'gone') { C.waking = false; C.woke = id; C.wokeAt = Date.now(); C.typing.hidden = true }
      if (CHAT === C) drawChatState(C)
    })
  } catch (e) { C.waking = false; C.woke = 'none'; C.typing.hidden = true; drawChatState(C) }
}
// The line above the message box: what's in the way of a reply, if anything (and the approval waiting, if any, offers
// answers only while its agent is up)
function drawChatState (C, nudge) {
  const a = agentOf(C.agent)
  if (!a) return
  drawAsking(C)
  if (a.state === 'ready' || a.state === 'installing') { C.waking = false; C.woke = null }   // it's up (after all)
  const ban = (tone, ic, text, action) => { C.banner.className = 'chat-banner ' + tone; C.banner.replaceChildren(icon(ic), h('span', { class: 'grow' }, text), action || ''); C.banner.hidden = false }
  C.empty.hidden = C.list.childElementCount > 0 || !C.loaded
  C.recipeBtn.hidden = !C.loaded || !C.empty.hidden
  if (C.recipeBtn.hidden && !C.recipePanel.hidden) recipesBy(C, false)
  const needs = RECIPES.map((r) => r.needs.filter((n) => !NEEDS[n].has(a.name)).join()).join('|')
  if (!C.empty.hidden && C.recipesFor !== needs) {
    C.recipesFor = needs
    C.recipes.replaceChildren(h('p', { class: 'recipes-title' }, 'Or start from a recipe'), recipeTiles(a, 'chat'))
  }
  if (DOWN) ban('bad', 'circle-alert', 'cage isn’t answering, so messages can’t go out right now.')
  else if (!a.enabled) ban('info', 'sparkles', `Add ${a.label} to chat with it. It uses ${a.plan}.`, btn('Add ' + a.label, () => runJob(['add', a.name], 'Adding ' + a.label), 'sm primary'))
  else if (a.state === 'login') ban('warn', 'log-in', `Sign ${a.label} in first (it uses ${a.plan}).`, btn('Sign in', () => runJob(['login', a.name], 'Sign ' + a.label + ' in'), 'sm primary'))
  else if (C.woke) {
    ban('bad', 'circle-alert', `Couldn’t wake ${a.label}. Your message is waiting for it.`, h('span', { class: 'row' }, btn('Try again', () => wake(C), 'sm'),
      C.woke !== 'none' && Date.now() - C.wokeAt < 9 * 60000 ? btn('See what happened', () => openJob(C.woke, ['up', a.name], 'Waking ' + a.label, true), 'sm ghost') : null))   // (kept 10 minutes)
  } else if (C.waking) ban('info', 'power', `Waking ${a.label} up… your message goes as soon as it’s ready (about a minute).`)
  else if (a.state === 'asleep' || a.state === 'none') ban('idle', 'moon', `${a.label} is asleep. Sending a message wakes it up.`)
  else if (a.state === 'installing') ban('info', 'loader-circle', `${a.label} is getting ready (the first time takes a few minutes). You can write already.`)
  else if (a.state === 'stuck') ban('bad', 'circle-alert', `${a.label} is stuck.`, btn('Restart', () => runJob(['up', a.name], 'Restarting ' + a.label), 'sm'))
  else if (C.connected === false) ban('warn', 'loader-circle', `${a.label}’s chat service is reconnecting. Your message goes as soon as it’s back.`)
  else C.banner.hidden = true
  if (nudge && !C.banner.hidden) { C.banner.classList.remove('nudge'); void C.banner.offsetWidth; C.banner.classList.add('nudge') }
}

function pageAgent (name, tab) {
  const a = agentOf(name)
  if (!a) return h('div', { class: 'page' }, pageHead('No such agent', ''), btn('Back to Home', () => go('home')))
  const s = statusOf(a)
  const st = STATUS[s]
  const tabs = [['', 'Chat', 'message-circle'], ['files', 'Files', 'folder'], ['schedule', 'Schedule', 'calendar-clock'], ['settings', 'Settings', 'settings']]
  const head = h('header', { class: 'agent-bar' },
    h('div', { class: 'agent-head', style: { '--c': AGENT[a.name].color } }, avatar(a.name, 40),
      h('div', {}, h('h1', {}, a.label), h('p', { class: 'status ' + st.tone }, dot(st.tone), st.label, h('span', { class: 'muted' }, ' · uses ' + a.plan)))),
    a.enabled ? h('nav', { class: 'tabs', 'aria-label': a.label }, tabs.map(([t, label, ic]) =>
      h('a', { href: '#agent/' + a.name + (t ? '/' + t : ''), class: (tab || '') === t ? 'on' : '', 'aria-current': (tab || '') === t ? 'page' : null }, icon(ic), label))) : null,
    !tab && a.enabled ? h('button', { type: 'button', class: 'icon-btn', title: 'New conversation', 'aria-label': 'New conversation', onclick: () => { if (CHAT) chatSend(CHAT, '/new') } }, icon('square-pen')) : null)
  if (!a.enabled) {
    return h('div', { class: 'page' }, head,
      h('div', { class: 'empty-state' }, icon('sparkles', 'lg'), h('h2', {}, 'Add ' + a.label),
        h('p', {}, `cage gives ${a.label} its own private computer and signs it in (it uses ${a.plan}). Then you chat with it right here; chat apps on your phone are optional.`),
        btn('Add ' + a.label, () => runJob(['add', a.name], 'Adding ' + a.label), 'primary')))
  }
  if (tab === 'files') return h('div', { class: 'page agent-page' }, head, pageFiles(a))
  if (tab === 'schedule') return h('div', { class: 'page agent-page' }, head, pageSchedule(a))
  if (tab === 'settings') return h('div', { class: 'page agent-page' }, head, agentSettings(a))
  const C = chatOpen(a.name)
  drawChatState(C)
  return h('div', { class: 'page agent-page chat-page' }, head, C.el)
}

// Scheduled tasks: cc-connect runs them in the agent's VM, in your time zone, while the agent is awake; what they say
// arrives in its chat here. The app reads and changes them through cc-connect's management API (guest/app.mjs).
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function cronOf (kind, time, day) {
  const [hh, mm] = String(time || '09:00').split(':').map((x) => parseInt(x, 10) || 0)
  if (kind === 'hourly') return `${mm} * * * *`
  if (kind === 'weekdays') return `${mm} ${hh} * * 1-5`
  if (kind === 'weekly') return `${mm} ${hh} * * ${day}`
  return `${mm} ${hh} * * *`
}
function filledTitle (draft, prompt) { // a recipe's title with its blanks as you filled them in its prompt ('' if you changed more)
  const names = draft.prompt.match(BLANK) || []
  const m = new RegExp('^' + draft.prompt.split(BLANK).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]+?)') + '$').exec(prompt)
  return m ? draft.title.replace(BLANK, (b) => m[names.indexOf(b) + 1] ?? b) : ''
}
function blanksNote (text) { const left = blanksLeft(text); return left.length ? ['Fill in ', ...left.flatMap((b, i) => [i ? ', ' : '', h('mark', { class: 'blank' }, b)]), ' first.'] : [] }
function cronText (expr) { // "0 8 * * 1-5" → "Every weekday at 8:00 AM"; anything unusual stays as it is
  const f = String(expr || '').trim().split(/\s+/)
  if (f.length === 6) f.shift()
  if (f.length !== 5) return expr
  const [m, hr, dom, mon, dow] = f
  if (dom !== '*' || mon !== '*' || !/^\d+$/.test(m)) return expr
  if (hr === '*' && dow === '*') return m === '0' ? 'Every hour, on the hour' : `Every hour at :${m.padStart(2, '0')}`
  if (!/^\d+$/.test(hr)) return expr
  const at = ' at ' + new Date(2000, 0, 1, +hr, +m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (dow === '*') return 'Every day' + at
  if (dow === '1-5') return 'Every weekday' + at
  if (dow === '0,6' || dow === '6,0') return 'Weekends' + at
  if (/^[0-7]$/.test(dow)) return 'Every ' + DAYS[+dow % 7] + at
  return expr
}
let SCHED = {}
async function cronApi (a, method, p, body) {
  const d = await api(`/api/chat/${a}/request`, { method: 'POST', body: { type: 'api', method, path: p, body } })
  if (d && d.ok === false) throw new Error(d.error || 'cc-connect said no')
  return (d && d.data) || {}
}
function pageSchedule (a) {
  const awake = ['ready', 'login', 'installing'].includes(a.state)
  const S = SCHED[a.name] || (SCHED[a.name] = { jobs: null, error: '', loading: false })
  const load = async () => {
    S.loading = true
    try { S.jobs = ((await cronApi(a.name, 'GET', '/api/v1/cron?project=' + a.name)).jobs || []).filter((j) => !j.project || j.project === a.name); S.error = '' } catch (e) { S.error = e.message }
    S.loading = false
    render(true)
  }
  if (awake && !S.loading && ((S.jobs === null && !S.error) || ARRIVED)) load()
  const sync = () => { day.hidden = kind.value !== 'weekly'; time.hidden = kind.value === 'hourly'; hint.replaceChildren(...blanksNote(what.value)) }
  // (what you choose here is kept through a redraw, like what you type: data-keep)
  const what = h('textarea', { rows: 3, placeholder: 'e.g. Summarize what came into my inbox overnight, most important first.', 'aria-label': 'What should it do?', 'data-keep': 'sched-what', oninput: () => sync(), onkept: () => sync() })
  const kind = h('select', { 'aria-label': 'How often', 'data-keep': 'sched-kind', onchange: () => sync(), onkept: () => sync() },
    [['weekdays', 'Every weekday'], ['daily', 'Every day'], ['weekly', 'Every week on'], ['hourly', 'Every hour']].map(([v, t]) => h('option', { value: v }, t)))
  const day = h('select', { 'aria-label': 'Day', 'data-keep': 'sched-day' }, DAYS.map((d, i) => h('option', { value: String(i), selected: i === 1 }, d)))
  const time = h('input', { type: 'time', value: '08:00', 'aria-label': 'Time', class: 'time', 'data-keep': 'sched-time' })
  const hint = h('span', { class: 'field-hint' })   // a recipe's blanks still to fill in
  const form = h('form', { class: 'stack sched-form' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'What should it do?'), what, hint),
    h('div', { class: 'row' }, kind, day, h('span', { class: 'muted' }, 'at'), time, h('span', { class: 'grow' }), h('button', { type: 'submit', class: 'btn primary' }, icon('plus'), 'Add')))
  sync()
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const prompt = what.value.trim()
    if (!prompt) return what.focus()
    if (pickBlank(what)) return toast(`Fill in ${blanksLeft(prompt)[0]} first.`, 'info')
    const title = S.draft ? filledTitle(S.draft, prompt) : ''   // (a recipe still, filled in; '' once it's what you wrote)
    if (!(await addUnwatched(a, title ? { title, needs: S.draft.needs } : null))) return
    try {
      await cronApi(a.name, 'POST', '/api/v1/cron', { project: a.name, session_key: 'app:you:you', cron_expr: cronOf(kind.value, time.value, day.value), prompt, description: (title || prompt.split('\n')[0]).slice(0, 80) })
      what.value = ''
      S.draft = null
      await load()
    } catch (err) { toast('Couldn’t add it: ' + err.message) }
  })
  const rowsOf = (S.jobs || []).map((j) => h('li', {}, h('span', { class: 'chat-mark' }, icon('calendar-clock')),
    h('span', { class: 'grow' }, h('b', {}, j.description || j.prompt || j.exec || 'A task'),
      h('span', { class: 'sub' }, [cronText(j.cron_expr), j.last_run && !/^0001/.test(j.last_run) ? 'last ran ' + ago(Date.parse(j.last_run) / 1000) : 'hasn’t run yet', j.enabled === false ? 'paused' : ''].filter(Boolean).join(' · ')),
      j.last_error ? h('span', { class: 'sub bad' }, j.last_error) : null),
    btn('Run now', async () => { try { await cronApi(a.name, 'POST', `/api/v1/cron/${j.id}/exec`); go('agent/' + a.name) } catch (e) { toast(e.message) } }, 'sm ghost', 'play'),
    btn('Delete', async () => {
      if (!(await confirmSheet(`Delete “${j.description || j.prompt || 'this task'}”? ${a.label} won’t do it any more.`, 'Delete', 'Keep it'))) return
      try { await cronApi(a.name, 'DELETE', '/api/v1/cron/' + j.id); await load() } catch (e) { toast(e.message) }
    }, 'sm ghost danger')))
  const tz = STATE.settings.tz
  return [
    section('Scheduled tasks', `Things ${a.label} does on its own, on a schedule. What it says shows up in the chat. They run while it’s awake${STATE.settings.autostart ? '' : ' (turn on Start at login so it is)'}${tz ? `, at your time (${tz.replace(/_/g, ' ')})` : ''}.`,
      h('div', { class: 'card flush' },
        !awake ? h('p', { class: 'empty' }, `${a.label} is asleep; wake it up to see and change its schedule.`)
          : S.error ? h('p', { class: 'empty' }, 'Couldn’t read its schedule: ' + S.error)
            : S.jobs === null ? h('p', { class: 'empty' }, 'Opening…')
              : rows(rowsOf, 'Nothing scheduled yet.'))),
    awake ? section('Start from a recipe', 'Ready-made tasks. Add one as it is, or fill in its blanks first.', recipeTiles(a, 'schedule')) : null,
    awake ? section('Add a task', 'Or just ask in the chat, like “every weekday at 8am, summarize my inbox”.', h('div', { class: 'card sched-card' }, form)) : null
  ]
}

// Files: what you and the agent sent each other, and its work folder (the agent's own computer)
let FILES = { agent: '', path: '', list: null, error: '' }
function pageFiles (a) {
  const C = chatOpen(a.name)
  if (FILES.agent !== a.name) FILES = { agent: a.name, path: '', list: null, error: '' }
  const shared = C.shared.slice().reverse()
  const awake = a.state === 'ready' || a.state === 'login' || a.state === 'installing'
  const work = h('div', { class: 'card flush' })
  const load = async (p) => {
    FILES.path = p
    try { const d = await api(`/api/chat/${a.name}/request`, { method: 'POST', body: { type: 'ls', path: p } }); FILES.list = d.ok ? d.entries : []; FILES.error = d.ok ? '' : d.error } catch (e) { FILES.error = e.message }
    drawWork()
  }
  const download = async (p, btnEl) => {
    btnEl.disabled = true
    try {
      const d = await api(`/api/chat/${a.name}/request`, { method: 'POST', body: { type: 'fetch', path: p } })
      if (!d.ok) throw new Error(d.error)
      const link = h('a', { href: fileUrl(a.name, d.path, true), download: d.name })
      document.body.append(link); link.click(); link.remove()
    } catch (e) { toast(e.message) }
    btnEl.disabled = false
  }
  const up = h('input', { type: 'file', multiple: true, hidden: true, onchange: async () => {
    for (const f of [...up.files]) {
      try {
        const res = await fetch(`/api/chat/${a.name}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Cage-Token': TOKEN }, body: f })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error)
        const r = await api(`/api/chat/${a.name}/request`, { method: 'POST', body: { type: 'put', from: d.path, dir: FILES.path, name: f.name } })
        if (!r.ok) throw new Error(r.error)
      } catch (e) { toast(`Couldn’t upload ${f.name}: ${e.message}`) }
    }
    up.value = ''
    load(FILES.path)
  } })
  function drawWork () {
    const crumbs = ['work', ...FILES.path.split('/').filter(Boolean)]
    work.replaceChildren(
      h('div', { class: 'crumbs' }, crumbs.map((c, i) => [i ? h('span', { class: 'muted' }, '/') : null,
        h('button', { type: 'button', class: 'crumb', onclick: () => load(crumbs.slice(1, i + 1).join('/')) }, c)]),
      h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn sm', onclick: () => up.click() }, icon('upload'), 'Upload here'), up),
      FILES.error ? h('p', { class: 'empty' }, FILES.error)
        : FILES.list === null ? h('p', { class: 'empty' }, 'Opening…')
          : rows(FILES.list.slice().sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name)).map((f) => {
            const p = (FILES.path ? FILES.path + '/' : '') + f.name
            return h('li', {}, h('span', { class: 'chat-mark' }, icon(f.dir ? 'folder' : 'file')),
              h('span', { class: 'grow' }, f.dir ? h('button', { type: 'button', class: 'linkish', onclick: () => load(p) }, h('b', {}, f.name)) : h('b', {}, f.name),
                h('span', { class: 'sub' }, f.dir ? 'Folder' : `${size(f.size)} · ${ago(f.at / 1000)}`)),
              f.dir ? null : h('button', { type: 'button', class: 'btn sm ghost', onclick: (e) => download(p, e.currentTarget) }, icon('download'), 'Download'))
          }), 'This folder is empty.'))
  }
  if (awake) { drawWork(); if (FILES.list === null || ARRIVED) load(FILES.path) } else work.append(h('p', { class: 'empty' }, `${a.label} is asleep; wake it up to see its work folder.`))
  return [
    section('In this chat', 'Files you sent each other.', h('div', { class: 'card flush' }, rows(shared.map((f) => h('li', {}, fileChip(a.name, f),
      h('span', { class: 'muted small' }, f.from === 'you' ? 'You sent' : nameOf(a.name) + ' sent'))), 'Nothing yet. Attach files to a message, or ask it to send you one.'))),
    section('Its work folder', `${a.label}’s own computer: what it makes and keeps. Download anything, or upload files for it to use.`, work)
  ]
}

// Plan usage, as each agent's /usage card says it: "5h limit\nRemaining: 58%\nResets: 2h 13m", for each window.
// cage's web app asks the agent at most every 10 minutes (server.py's Usage); this page asks the web app every minute.
// Only Claude Code and Codex can tell.
let USAGE = {}   // agent → its last answer (with "asked", and "stale" if a newer one wasn't good), or {error}
const USAGE_ASKING = {}
const TELLS_USAGE = ['claude', 'codex']
const WINDOWS = { '5h': '5-hour', '7d': 'Weekly' }
function usageOf (u) { // [{label, left, reset}]: what's left in each window; [] if the answer says something else
  const card = u && u.card && typeof u.card === 'object' ? u.card : null
  const text = card ? (card.elements || []).filter((e) => e && e.type === 'markdown').map((e) => String(e.content || '')).join('\n') : String((u && u.text) || '')
  return [...text.matchAll(/(\S+) limit\s*\n\s*Remaining:\s*(\d+)%[\s\S]*?Resets:\s*([^\n]+)/g)]
    .map(([, w, left, reset]) => ({ label: WINDOWS[w] || w + ' limit', left: Math.min(100, +left), reset: reset.trim() }))
}
// When a window starts afresh, from what cc-connect said when it was asked ("2h 13m", "3d 4h 0m"): as a time, which
// stays true while the page sits there (and the answer may be minutes old: the web app keeps one for 10 minutes)
function resetsAt (reset, asked) {
  const m = /^(?:(\d+)d\s*)?(?:(\d+)h\s*)?(\d+)m$/.exec(reset)
  if (!m || !asked) return 'resets in ' + reset
  const at = asked * 1000 + ((+(m[1] || 0) * 24 + +(m[2] || 0)) * 60 + +m[3]) * 60000
  if (at <= Date.now()) return 'has reset since it was checked'
  const days = (new Date(at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5
  return 'resets ' + (days < 1 ? 'at ' + clock(at) : days < 2 ? 'tomorrow at ' + clock(at)
    : days < 7 ? new Date(at).toLocaleDateString([], { weekday: 'long' }) + ' at ' + clock(at) : 'on ' + new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' }))
}
function wantUsage (a) { // ask again if it's been a minute (the web app answers from what it has)
  const u = USAGE[a.name]
  if (a.state === 'ready' && TELLS_USAGE.includes(a.name) && !USAGE_ASKING[a.name] && (!u || Date.now() - u.got > 60000)) loadUsage(a.name)
}
async function loadUsage (name, fresh) {
  if (USAGE_ASKING[name]) return
  USAGE_ASKING[name] = true
  try { USAGE[name] = { ...(await api(`/api/chat/${name}/usage`, { method: 'POST', body: fresh ? { fresh: true } : {} })), got: Date.now() } } catch (e) { USAGE[name] = { error: e.message, got: Date.now() } }
  USAGE_ASKING[name] = false
  drawUsage(name)
}
function drawUsage (name) { // wherever its usage is shown (Home, its settings), without drawing the whole page again
  const a = STATE && agentOf(name)
  if (a) document.querySelectorAll(`[data-usage="${name}"]`).forEach((el) => el.replaceChildren(...[usageView(a, el.dataset.offer === '1')].flat().filter(Boolean)))
}
function usageView (a, offer) { // bars, or why there are none; offer: a stand-in, for an agent that has used it all up
  const say = (text) => h('p', { class: 'muted small' }, text)
  if (!TELLS_USAGE.includes(a.name)) return say('Not reported')
  if (a.state !== 'ready') return say(a.state === 'login' ? 'Sign it in to see how much is left.' : 'Wake it up to see how much is left.')
  const u = USAGE[a.name]
  if (!u || (USAGE_ASKING[a.name] && !u.got)) return say('Checking…')
  if (u.error) return say(u.error)
  const windows = usageOf(u)
  if (!windows.length) return say(plainLine(u.text || (u.card && u.card.elements || []).map((e) => (e && (e.content || e.text)) || '').join(' '), 200) || 'It didn’t say.')
  const others = agentsOn().filter((b) => b.name !== a.name)
  return [
    h('div', { class: 'usage-bars' }, windows.map((w) => h('div', { class: 'usage-bar ' + (w.left <= 0 ? 'bad' : w.left < 20 ? 'warn' : 'ok') },
      h('span', { class: 'usage-label' }, h('b', {}, w.label + ': '), `${w.left}% left` + (w.reset && w.reset !== '-' ? ', ' + resetsAt(w.reset, u.asked) : '')),
      h('span', { class: 'meter', 'aria-hidden': 'true' }, h('span', { style: { width: w.left + '%' } }))))),
    u.stale ? say('It didn’t answer the last time; this is from ' + when(u.asked * 1000) + '.') : null,
    offer && windows.some((w) => w.left <= 0) && !a.fallback && others.length
      ? h('div', { class: 'plan-out' }, h('span', {}, `${a.label} has used up its plan for now. Until it resets, another agent can answer its messages:`), fallbackSelect(a, others))
      : null
  ]
}

// Asking first (cage approve): Claude Code asks before it uses your apps, Cursor and Antigravity before every action.
// Codex can't ask at all: with it on, cc-connect runs Codex in its read-only sandbox and never asks (approval_policy
// never), so its switch is called what it does, and nothing says it asks.
function askingFirst (a) {
  if (a.name === 'codex') {
    return section('Working read-only', '', h('div', { class: 'card' },
      setting('Work read-only', 'Codex can’t ask you before it acts. With this on, it works read-only instead: it can read and answer, but not change files. Apps you connected for it may still let it act, so to be sure, don’t connect apps to Codex.',
        toggle(a.approve, (on) => runJob(['approve', a.name, on ? 'on' : 'off'], 'Working read-only'), 'Work read-only'))))
  }
  return section('Asking first', '', h('div', { class: 'card' },
    setting('Ask before acting in your apps', a.name === 'claude'
      ? 'Before it sends an email, books a meeting or changes anything in an app you connected, it asks you in the chat. Work on its own computer goes ahead.'
      : `${a.label} can only ask before every action, so expect more questions. It asks in the chat, with Allow and Deny buttons.`,
    toggle(a.approve, (on) => runJob(['approve', a.name, on ? 'on' : 'off'], 'Asking first'), 'Ask before acting'))))
}

// Settings for one agent: chat apps, asking first (or working read-only), plan usage, privacy, stand-in, troubleshooting
function agentSettings (a) {
  const s = statusOf(a)
  const meta = AGENT[a.name]
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
  wantUsage(a)
  const again = () => { USAGE[a.name] = null; drawUsage(a.name); loadUsage(a.name, true) }
  return [
    section('Plan usage', `How much is left on its plan (${a.plan}). Only Claude Code and Codex can tell.`, h('div', { class: 'card usage-card' },
      h('div', { class: 'usage', 'data-usage': a.name }, usageView(a)),
      a.state === 'ready' && TELLS_USAGE.includes(a.name) ? h('div', { class: 'row' }, btn('Check again', again, 'sm ghost', 'refresh-cw')) : null)),
    askingFirst(a),
    section('Chat apps', 'Talk to it from your phone too. Only you can message it, unless you let others in.', h('ul', { class: 'list chats' }, CHATS.map(([k, n]) => chatRow(k, n)))),
    section('Preferences', '', h('div', { class: 'card' },
      setting('Privacy mask', `In what you type, your About me and your notes’ names and titles, emails, phone and card numbers, bank details, keys and your own words reach ${meta.vendor} as placeholders like [EMAIL_1], and come back as themselves. Files and pictures you send, notes and web pages it opens, and app results go as they are; voice notes go to Groq as they are, if you use Groq for them. Anyone who can chat with it can ask it about masked values, and so can a web page or app result it reads. The real values are kept in its VM, so something that tells it to look there can find them.`,
        toggle(a.mask, (on) => runJob(['mask', on ? 'on' : 'off', a.name], 'Privacy mask for ' + a.label), 'Privacy mask for ' + a.label)),
      setting('When it hits its usage limit', 'Another agent answers your message in its chat instead.', others.length ? fallbackSelect(a, others) : h('span', { class: 'muted small' }, 'Add another agent first')))),
    section('Troubleshooting', 'You won’t usually need these.', h('div', { class: 'tools' },
      s === 'ready' || s === 'stuck' || s === 'login' || s === 'installing' ? [
        btn('Activity log', () => runJob(['logs', a.name], a.label + ': activity log'), '', 'scroll-text'),
        btn('Sign in again', () => runJob(['login', a.name], 'Sign ' + a.label + ' in'), '', 'log-in'),
        btn('Restart', () => runJob(['up', a.name], 'Restarting ' + a.label), '', 'rotate-cw'),
        btn('Terminal', () => runJob(['shell', a.name], 'Inside ' + a.label + '’s computer'), '', 'square-terminal'),
        btn('Put to sleep', () => runJob(['down', a.name], 'Putting ' + a.label + ' to sleep'), '', 'moon')
      ] : btn('Wake up', () => runJob(['up', a.name], 'Waking ' + a.label), '', 'power')))
  ]
}
function fallbackSelect (a, others) {
  return h('select', {
    'aria-label': 'Stand-in for ' + a.label,
    'aria-busy': busy('Stand-in for ' + a.label),
    onchange: (e) => { const to = e.target.value; asked(e.target, a.fallback || ''); runJob(['fallback', a.name, to || 'off'], 'Stand-in for ' + a.label) }
  },
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
    h('details', { class: 'disclosure', 'data-open': 'another-app' }, h('summary', {}, icon('plus'), 'Another app'), h('p', { class: 'small muted' }, 'Anything with a remote MCP server. cage asks for its key, or signs you in with your browser.'), custom))
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

// What you wrote about yourself: read once when you arrive (a redraw keeps what's in the box, see render()), and not
// lost by accident: the page says when it isn't saved, and asks before you leave.
const ABOUT = { saved: null, note: '', keep: '' }
function aboutBox (keep, attrs) {
  const ta = h('textarea', { ...attrs, 'data-keep': keep, oninput: () => aboutDrawn() })
  if (ARRIVED || ABOUT.saved === null || ABOUT.keep !== keep) {
    Object.assign(ABOUT, { saved: null, note: '', keep })
    api('/api/memory/about').then((d) => {
      ABOUT.saved = d.text || ''
      const el = document.querySelector(`[data-keep="${keep}"]`)   // after a redraw, a new box
      if (el && !el.value) el.value = keep === 'about' || !/^# About me\s*(<!--[\s\S]*?-->)?\s*$/.test(ABOUT.saved) ? ABOUT.saved : ''
      aboutDrawn()
    }).catch(() => {})
  }
  UNSAVED = () => { const v = aboutText(keep); return ABOUT.saved !== null && v.trim() !== '' && v !== ABOUT.saved }
  return ta
}
function aboutText (keep) { const el = document.querySelector(`[data-keep="${keep}"]`); return el ? el.value : '' }   // the box now on the page
function aboutDrawn () { const el = document.getElementById('about-status'); if (el) el.textContent = unsaved() ? 'Unsaved changes' : ABOUT.note }
function pageMemory () {
  const S = STATE
  const ta = aboutBox('about', { 'aria-label': 'About you', placeholder: 'Your name, what you do, how you like answers…', rows: 10 })
  const status = h('span', { class: 'muted small', id: 'about-status' }, unsaved() ? 'Unsaved changes' : ABOUT.note)
  const save = btn('Save', async () => {
    const text = aboutText('about')
    try { await api('/api/memory/about', { method: 'PUT', body: { text } }); ABOUT.saved = text; ABOUT.note = 'Saved. Your agents see it the next time they wake up.' } catch (e) { ABOUT.note = e.message }
    aboutDrawn()
  }, 'primary')
  return h('div', { class: 'page' }, pageHead('Memory', 'What all your agents know about you. They suggest new things; nothing is kept until you say so.'),
    section('Suggestions', '', h('div', { class: 'card row spread' },
      h('span', {}, S.memory.inbox > 0 ? `Your agents want to remember ${plural(S.memory.inbox, 'new thing')}.` : 'Nothing new to review.'),
      S.memory.inbox > 0 ? btn('Review', () => runJob(['memory'], 'What your agents want to remember'), 'primary') : null)),
    section('About you', 'Every agent reads this. Write it like a note to a new colleague.', h('div', { class: 'stack' }, ta, h('div', { class: 'row' }, save, status))))
}

let SECURITY_SEEN = ''   // what cage blocked, as the page last told cage you'd seen it
function pageSecurity () {
  const S = STATE
  // you've seen them now: said once when you arrive, and again when something new comes in while you look (not at
  // every redraw, which would run cage once more each time until it has answered)
  const blocked = S.events.unseen + ' ' + JSON.stringify(S.events.recent[0] || null)
  if (S.events.unseen > 0 && (ARRIVED || blocked !== SECURITY_SEEN)) { SECURITY_SEEN = blocked; quietJob(['security']) }
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
    type: 'checkbox',
    checked: a.mask,
    'aria-label': 'Mask for ' + a.label,
    'aria-busy': busy('Mask for ' + a.label),
    onchange: (e) => { asked(e.target, a.mask); runJob(['mask', a.mask ? 'off' : 'on', a.name], 'Privacy mask for ' + a.label) }
  }), avatar(a.name, 16), a.label)))
  const term = h('input', { type: 'text', placeholder: 'A client, a project, a person', required: true, 'data-keep': 'mask-term' })
  const termForm = h('form', { class: 'add-row tight' }, term, h('button', { type: 'submit', class: 'btn' }, 'Hide this too'))
  termForm.addEventListener('submit', (e) => { e.preventDefault(); runJob(['mask', 'add', term.value.trim()], 'Privacy mask') })
  const tryIn = h('input', { type: 'text', placeholder: 'Try: email bob@acme.com about Acme', 'data-keep': 'mask-try' })
  const tryForm = h('form', { class: 'add-row tight' }, tryIn, h('button', { type: 'submit', class: 'btn' }, 'Preview'))
  tryForm.addEventListener('submit', (e) => { e.preventDefault(); if (tryIn.value) runJob(['mask', 'try'], 'What the AI company would see', null, tryIn.value) })
  const fallbacks = h('div', { class: 'stack tight' }, agentsOn().map((a) => {
    const others = agentsOn().filter((b) => b.name !== a.name)
    return h('div', { class: 'row' }, h('span', { class: 'fallback-who' }, avatar(a.name, 16), a.label), icon('chevron-right', 'muted'), others.length ? fallbackSelect(a, others) : h('span', { class: 'muted small' }, 'nobody else yet'))
  }))
  const backups = S.backups.files.map((b) => h('li', {}, h('span', { class: 'chat-mark' }, icon('archive')), h('span', { class: 'grow' }, h('b', {}, b.name), h('span', { class: 'sub' }, `${size(b.size)} · ${ago(b.at)}`)),
    btn('Restore', () => runJob(['restore', b.path], 'Restore ' + b.name), 'sm ghost')))
  return h('div', { class: 'page' }, pageHead('Settings', ''),
    section('Privacy mask', 'In what you type, your About me and your notes’ names and titles, emails, phone and card numbers, bank details, keys and your own words reach the AI company as placeholders like [EMAIL_1], and come back as themselves. Files and pictures you send, notes and web pages the agent opens, and app results reach it as they are; voice notes go to Groq as they are, if you use Groq for them. Anyone who can chat with the agent can ask it about masked values, and so can a web page or app result it reads. The real values are kept in the agent’s VM, so something that tells it to look there can find them, and the agent can’t use a hidden value itself.', h('div', { class: 'card' },
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
      setting('Desktop notifications', 'When an agent answers, sends a file or wants your OK while you’re looking elsewhere. Only on this computer.',
        toggle(notifyOn(), (on) => setNotify(on), 'Desktop notifications')),
      setting('An app of its own', installed() ? 'cage is installed: it has its own window and taskbar icon.' : 'Its own window and taskbar icon, instead of a browser tab.',
        installed() ? h('span', { class: 'status ok' }, icon('circle-check'), 'Installed')
          : INSTALL ? btn('Install', installApp, '', 'app-window') : h('span', { class: 'muted small' }, 'In Chrome or Edge: the install icon in the address bar')),
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
  for (const a of agentsOn()) {
    items.push(['square-pen', 'New conversation with ' + a.label, () => newConversation(a.name)],
      ['calendar-clock', 'Schedule a task for ' + a.label, () => { go('agent/' + a.name + '/schedule'); setTimeout(() => { const t = document.querySelector('[data-keep="sched-what"]'); if (t) t.focus() }, 60) }])
    if (a.state === 'ready') items.push(['square', 'Stop ' + a.label, () => openChat(a.name) && chatSend(CHAT, '/stop')])
  }
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
  const input = h('input', {
    type: 'text', placeholder: 'Go to, or do…', 'aria-label': 'Go to, or do', autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list'
  })
  const list = h('ul', { class: 'pal-list', role: 'listbox', id: 'pal-list', 'aria-label': 'Places and actions' })
  let hits = []
  let at = 0
  const draw = () => {
    const q = input.value.trim().toLowerCase()
    hits = paletteItems().filter(([, label]) => !q || label.toLowerCase().includes(q))
    at = Math.min(at, Math.max(0, hits.length - 1))
    list.replaceChildren(...hits.map(([ic, label, fn, agent, note], i) => h('li', {
      role: 'option', id: 'pal-' + i, class: i === at ? 'on' : '', 'aria-selected': i === at ? 'true' : 'false',
      onmousemove: () => { if (at !== i) { at = i; draw() } }, onclick: () => pick(i)
    }, agent ? avatar(agent, 18) : icon(ic), h('span', { class: 'grow' }, label), note ? h('span', { class: 'muted small' }, note) : null)))
    if (!hits.length) list.append(h('li', { class: 'pal-empty', role: 'presentation' }, 'Nothing matches.'))
    if (hits.length) input.setAttribute('aria-activedescendant', 'pal-' + at); else input.removeAttribute('aria-activedescendant')
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
function openChat (name) { // an agent's chat, now (not after the next hashchange): the open chat, or null if you stayed
  if (page !== 'agent/' + name) { location.hash = 'agent/' + name; route() }
  return CHAT && CHAT.agent === name && page === 'agent/' + name ? CHAT : null
}
function newConversation (name) { const C = openChat(name); if (C) chatSend(C, '/new') }
// Shortcuts: Ctrl+K (⌘K) jumps anywhere; Alt+1…4 opens an agent's chat (as listed in the sidebar); Ctrl+Shift+O
// (⌘⇧O) starts a new conversation with the agent you're on; Esc stops an agent that's working, while you haven't
// typed anything; ? lists them.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const KEYS = [[MAC ? '⌘K' : 'Ctrl K', 'Go to, or do, anything'], [MAC ? '⌥1 … ⌥4' : 'Alt 1 … Alt 4', 'Open an agent’s chat, as listed on the left' + (MAC ? ' (when you’re not typing)' : '')],
  [MAC ? '⌘⇧O' : 'Ctrl Shift O', 'Start a new conversation with this agent'], ['Esc', 'Stop the agent while it’s working (with nothing typed)'],
  ['Enter', 'Send'], ['Shift Enter', 'A new line'], ['?', 'These shortcuts']]
const keysSheet = document.getElementById('keys')
function showKeys () {
  keysSheet.replaceChildren(h('header', { class: 'sheet-head' }, h('h2', { id: 'keys-title' }, 'Keyboard shortcuts'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => keysSheet.close() }, icon('x'))),
  h('dl', { class: 'keys-list' }, KEYS.map(([k, what]) => h('div', {}, h('dt', {}, k.split(' ').map((x) => x === '…' ? ' … ' : h('kbd', {}, x))), h('dd', {}, what)))))
  keysSheet.showModal()
}
keysSheet.addEventListener('click', (e) => { if (e.target === keysSheet) keysSheet.close() })
document.addEventListener('keydown', (e) => {
  if (dlg.open) return   // in the side panel, Ctrl+K is the terminal's (and the panel is modal anyway)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (pal.open) pal.close(); else openPalette() }
  if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); return }   // (and nothing else)
  if (!STATE || !STATE.configured || document.querySelector('dialog[open]')) return
  const field = typing(document.activeElement)
  // By the key, as Alt+1 on a Mac is "¡". But in a box you type in, only Alt with a plain digit: on a Mac, Option and a
  // digit is how many keyboards type "#", "@", "$" or "£", which must go into the box, not to another page.
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-4]$/.test(e.code) && !(field && !/^[1-4]$/.test(e.key))) {
    const a = STATE.agents.slice().sort((x, y) => y.enabled - x.enabled)[+e.code.slice(5) - 1]
    if (a) { // its chat, ready to write in (unless you stay, to save what you wrote on this page)
      e.preventDefault()
      if (!a.enabled) go('agent/' + a.name)
      else { const C = openChat(a.name); if (C) C.ta.focus() }
    }
  } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyO') {
    if (page.startsWith('agent/')) { e.preventDefault(); newConversation(page.split('/')[1]) }
  } else if (e.key === 'Escape' && CHAT && page === 'agent/' + CHAT.agent && !CHAT.typing.hidden && !CHAT.ta.value.trim() && (!field || document.activeElement === CHAT.ta)) {
    e.preventDefault()
    chatSend(CHAT, '/stop')
  } else if (e.key === '?' && !field && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault()
    showKeys()
  }
})

// --- notifications: replies and questions from agents you're not looking at ----------------------------------------
// One stream for all agents, from where you last read each chat; what arrives while you're elsewhere marks the agent
// unread in the sidebar and, if you turned them on, shows a desktop notification (through the service worker, so it
// works installed too).
const NOTES = { unread: {} }
// How far you've read each agent's chat (seen) and been told about it (told), as offsets in its log, kept in this
// browser: what came while the page was closed is still unread when it opens again, and is notified only once. ino:
// which log those offsets are in (the server's name for it), as the VM starts a new one now and then.
const READ = (() => { try { const r = JSON.parse(localStorage.getItem('cage-read')); if (r && r.seen && r.told) return { ...r, ino: r.ino || {} } } catch (e) {} return { seen: {}, told: {}, ino: {} } })()
function keepRead () { try { localStorage.setItem('cage-read', JSON.stringify(READ)) } catch (e) {} }
function onAgent (agent) { return page === 'agent/' + agent || page.startsWith('agent/' + agent + '/') }   // its chat, files, schedule or settings
function looking (agent) { return onAgent(agent) && document.visibilityState === 'visible' }
function saw (agent) { // you're looking at it: everything so far is read
  const o = LIVE.offsets[agent]
  if (NOTES.unread[agent]) { delete NOTES.unread[agent]; if (STATE) drawNav() }
  if (o === undefined || o < 0 || (READ.seen[agent] === o && READ.told[agent] >= o)) return
  READ.seen[agent] = o
  READ.told[agent] = Math.max(READ.told[agent] ?? -1, o)
  keepRead()
}
let INSTALL = null   // the browser's "install this app" prompt, when it offers one
function notifyOn () { try { return localStorage.getItem('cage-notify') === 'on' && 'Notification' in window && Notification.permission === 'granted' } catch (e) { return false } }
// Every agent's chat on one stream (a browser allows only a few connections to a site): the open chat's new lines,
// and the others' for unread marks and notifications. offsets: how far each log has been seen.
const LIVE = { es: null, key: '', offsets: {}, ino: {} }
function liveConnect (force) {
  if (!STATE) return
  const names = agentsOn().map((a) => a.name)
  const key = names.join(',')
  if (!force && LIVE.es && key === LIVE.key) return
  if (LIVE.es) LIVE.es.close()
  LIVE.es = null
  LIVE.key = key
  if (!names.length) return
  const at = (a, o, ino) => a + ':' + o + (ino ? ':' + ino : '')   // an offset, and which log it's in when that's known
  const from = names.map((a) => LIVE.offsets[a] !== undefined ? at(a, LIVE.offsets[a], LIVE.ino[a]) : at(a, READ.seen[a] ?? -1, READ.ino[a])).join(',')
  const es = new EventSource(`/api/chat/stream?from=${encodeURIComponent(from)}&token=${encodeURIComponent(TOKEN)}`)
  LIVE.es = es
  es.onopen = () => { document.body.dataset.live = 'on' }
  es.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.start) { // where it starts: the end, the first time this browser looks (what came before isn't news)
      const was = LIVE.offsets[d.a] ?? READ.seen[d.a]
      LIVE.offsets[d.a] = d.o
      // Before what this page read: a new log, one the page didn't know the name of (kept from before it was told).
      // Read on from here, or nothing would be news until the new log is as long as the old one was.
      if (was === undefined || d.o < was) {
        READ.seen[d.a] = READ.told[d.a] = d.o
        if (was !== undefined && CHAT && CHAT.agent === d.a) chatLoad(CHAT, true)
      }
      if (d.ino) READ.ino[d.a] = LIVE.ino[d.a] = d.ino
      keepRead()
      if (looking(d.a)) saw(d.a)
      return
    }
    if (d.reset) { // the VM started a new log (the old one is kept): the open chat is read again, nothing is lost
      LIVE.offsets[d.a] = 0
      READ.seen[d.a] = READ.told[d.a] = 0   // offsets in the new one
      if (d.ino) READ.ino[d.a] = LIVE.ino[d.a] = d.ino
      keepRead()
      if (CHAT && CHAT.agent === d.a) chatLoad(CHAT, true)
      return
    }
    if (!d.e || d.o <= (LIVE.offsets[d.a] ?? -1)) return
    LIVE.offsets[d.a] = d.o
    if (CHAT && CHAT.agent === d.a) chatLive(CHAT, d)
    heard(d.a, d.e, d.o)
    if (['you', 'buttons', 'action', 'reply', 'typing', 'error'].includes(d.e.t)) activitySoon()   // Home shows it
  }
  es.onerror = () => { document.body.dataset.live = 'off'; es.close(); if (LIVE.es === es) { LIVE.es = null; setTimeout(() => liveConnect(true), 3000) } }
}
function heard (agent, e, o) {
  if ((e.session || 'you') !== 'you' || !['reply', 'buttons', 'card', 'file'].includes(e.t)) return
  if (looking(agent)) return saw(agent)
  if (!onAgent(agent)) { NOTES.unread[agent] = (NOTES.unread[agent] || 0) + 1; drawNav() }
  if (o <= (READ.told[agent] ?? -1)) return   // told already, before the page was opened again
  READ.told[agent] = o
  keepRead()
  if (!notifyOn()) return
  const perm = e.t === 'buttons' && (e.buttons || []).flat().some((b) => /^perm:/.test(b.data))
  const text = perm ? 'wants your OK: ' + approvalLine(approvalOf(e.text)) : e.t === 'file' ? 'sent you ' + (e.name || 'a file') : (e.text || (e.card && e.card.header && e.card.header.title) || '')
  const opts = { body: text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180), icon: 'icon-192.png', badge: 'icon-192.png', tag: 'cage-' + agent, data: { url: '/#agent/' + agent }, requireInteraction: perm }
  const title = nameOf(agent)
  const fallback = () => { const n = new Notification(title, opts); n.onclick = () => { window.focus(); go('agent/' + agent); n.close() } }
  if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(fallback)
  else fallback()
}
async function setNotify (on) {
  if (on && 'Notification' in window && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission()
    if (p !== 'granted') { toast('Your browser blocked notifications for cage. You can allow them in its site settings.'); on = false }
  }
  try { localStorage.setItem('cage-notify', on ? 'on' : 'off') } catch (e) {}
  if (BUSY === 'Desktop notifications') BUSY = ''   // done here and now, not by a job
  render(true)
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); INSTALL = e; if (STATE) drawNav() })
window.addEventListener('appinstalled', () => { INSTALL = null; if (STATE) render(true) })
async function installApp () {
  if (!INSTALL) return
  INSTALL.prompt()
  await INSTALL.userChoice.catch(() => {})
  INSTALL = null
  render(true)
}
const installed = () => window.matchMedia && window.matchMedia('(display-mode: standalone)').matches

// --- the frame: sidebar, routing ---------------------------------------------------------------------------------
function go (p) { location.hash = p }
function drawNav () {
  const S = STATE
  const list = document.getElementById('nav-agents')
  list.replaceChildren(...S.agents.slice().sort((a, b) => b.enabled - a.enabled).map((a) => {
    const st = STATUS[statusOf(a)]
    return h('a', { href: '#agent/' + a.name, 'data-nav': 'agent/' + a.name, class: a.enabled ? '' : 'off', title: a.label + ': ' + st.label },
      avatar(a.name, 18), h('span', { class: 'label' }, a.label), NOTES.unread[a.name] ? h('span', { class: 'badge unread', 'aria-label': plural(NOTES.unread[a.name], 'new message') }, String(NOTES.unread[a.name])) : null,
      a.enabled ? dot(st.tone) : h('span', { class: 'nav-add' }, icon('plus')))
  }))
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page.split('/').slice(0, 2).join('/')))
  const badge = (id, n) => { const b = document.getElementById(id); b.hidden = !n; b.textContent = n || '' }
  badge('badge-memory', S.memory.inbox)
  badge('badge-security', S.events.unseen)
  const ver = document.getElementById('version')
  ver.replaceChildren(h('span', {}, 'cage ' + S.version))
  if (newer(LATEST, S.version)) ver.append(h('button', { type: 'button', class: 'update', onclick: () => runJob(['update'], 'Updating cage') }, icon('download'), 'Update to ' + LATEST))
  if (INSTALL && !installed()) ver.append(h('button', { type: 'button', class: 'update', onclick: installApp }, icon('app-window'), 'Install as an app'))
  const todo = agentsOn().filter((a) => ['login', 'stuck'].includes(statusOf(a))).length + S.connectors.filter((c) => c.broken).length + (S.events.unseen ? 1 : 0)
  const unread = Object.values(NOTES.unread).reduce((x, y) => x + y, 0)
  const waiting = agentsOn().filter(askingOf).length
  document.title = todo + unread + waiting ? `(${todo + unread + waiting}) cage` : 'cage'
  document.getElementById('crumb').textContent = page.startsWith('agent/') ? nameOf(page.slice(6).split('/')[0]) : ({ home: 'Home', apps: 'Apps', signins: 'Sign-ins & keys', memory: 'Memory', security: 'Security', settings: 'Settings' })[page] || ''
}
let ARRIVED = false   // true while a page is drawn on arriving at it (not on a redraw): the time to reload what it shows
// What you're in the middle of on a page, which a redraw (the state changed, a job ended) keeps: the text in its boxes
// (data-keep), the agents you ticked or unticked (named checkboxes: a "for which agents" menu, the Ask box), and the
// menus and sections you opened (data-open). Switches have no name: they show what's true, not what was clicked.
function formState (root) {
  const s = { text: {}, ticks: {}, open: {} }
  root.querySelectorAll('[data-keep]').forEach((el) => { s.text[el.dataset.keep] = el.value })
  root.querySelectorAll('input[type=checkbox][name]:not(:disabled)').forEach((el) => { s.ticks[el.name + '/' + el.value] = el.checked })
  root.querySelectorAll('details[data-open]').forEach((el) => { s.open[el.dataset.open] = el.open })
  return s
}
function keepForm (root, s) {
  root.querySelectorAll('[data-keep]').forEach((el) => { if (s.text[el.dataset.keep]) { el.value = s.text[el.dataset.keep]; el.dispatchEvent(new Event('kept')) } })
  root.querySelectorAll('input[type=checkbox][name]:not(:disabled)').forEach((el) => { // (one that was greyed out starts afresh)
    const was = s.ticks[el.name + '/' + el.value]
    if (was !== undefined && was !== el.checked) { el.checked = was; el.dispatchEvent(new Event('change')) }   // its menu's summary follows
  })
  root.querySelectorAll('details[data-open]').forEach((el) => { if (el.dataset.open in s.open) el.open = s.open[el.dataset.open] })
}
function render (force) {
  if (!STATE) return
  document.body.classList.remove('is-locked')
  document.body.classList.toggle('unconfigured', !STATE.configured)
  drawNav()
  // (Home shows what each agent is doing: not "today", which changes with every message and would only take the focus)
  const key = page + '\n' + LATEST + '\n' + JSON.stringify(STATE) + (page === 'home' ? JSON.stringify([Object.entries(ACTIVITY).map(([a, x]) => [a, x.pending, x.working, x.last]), ANSWERED, FORGOTTEN]) : '')
  const main = document.getElementById('main')
  if (!force && key === SEEN && main.dataset.page === page) return   // nothing changed
  // keep what you're typing: don't redraw a page while you're in one of its fields
  if (!force && main.contains(document.activeElement) && typing(document.activeElement) && main.dataset.page === page) return
  const kept = main.dataset.page === page ? formState(main) : null
  const was = main.contains(document.activeElement) ? document.activeElement : null
  // what has the focus, to give it back: by its label (a switch, Allow for one agent), a link by where it goes and what
  // it says (an agent's Chat), or a heading by what it says (Needs you, after an answer there). A link whose words
  // changed (an agent's row on Home, which says what it's doing) by where it goes and what kind it is, if only one is.
  const keyOf = (el) => el.getAttribute('aria-label') || (el.tagName === 'A' ? el.getAttribute('href') + '\n' + el.textContent
    : /^H[2-6]$/.test(el.tagName) ? el.tagName + '\n' + el.textContent : '')
  const kindOf = (el) => el.tagName === 'A' && !el.hasAttribute('aria-label') ? el.getAttribute('href') + '\n' + el.className : ''
  const focused = was && keyOf(was)
  const kind = was && kindOf(was)
  const onHead = !!was && was.tagName === 'H1'   // the page's heading, where arriving put it
  document.body.classList.toggle('in-setup', page === 'setup')
  const fn = page === 'setup' ? pageSetup : !STATE.configured ? pageHome
    : page.startsWith('agent/') ? () => pageAgent(...page.slice(6).split('/'))
      : { home: pageHome, apps: pageApps, signins: pageSignins, memory: pageMemory, security: pageSecurity, settings: pageSettings }[page]
  const same = main.dataset.page === page
  main.dataset.page = page
  ARRIVED = !same
  main.replaceChildren(fn())
  ARRIVED = false
  if (kept) keepForm(main, kept)
  if (same && focused) {
    const all = [...main.querySelectorAll('[aria-label], a[href], h2, h3')]
    const like = kind ? all.filter((x) => kindOf(x) === kind) : []
    const el = all.find((x) => keyOf(x) === focused) || (like.length === 1 ? like[0] : null)
    if (el) { if (/^H\d$/.test(el.tagName)) el.tabIndex = -1; el.focus({ preventScroll: true }) }
  }
  if (!same) window.scrollTo(0, 0)
  // On arriving at a page (not on a redraw), focus goes to its heading: a screen reader says where you are, and Tab
  // goes on from there. Not from under a side panel or a question that's open. A redraw keeps it there (it draws a new
  // heading, and the focus would fall back to the top of the page).
  const h1 = main.querySelector('h1')
  if (h1 && (same ? onHead : !document.querySelector('dialog[open]'))) { h1.tabIndex = -1; h1.focus({ preventScroll: true }) }
  SEEN = key
}
function route () {
  const raw = location.hash.slice(1)
  if (/^pair=[0-9a-f]{16,128}$/.test(raw) || /^[0-9a-f]{32,}$/.test(raw)) { // from `cage ui` (or an older one's address)
    history.replaceState(null, '', location.pathname + '#home')
    signIn(raw).then(route)
    return
  }
  const p = raw
  const next = PAGES.includes(p) || /^agent\/[a-z]+(\/(files|schedule|settings))?$/.test(p) ? p : 'home'
  if (next !== page && unsaved() && LEAVING !== next) {
    history.replaceState(null, '', location.pathname + '#' + page)   // stay (this doesn't fire another hashchange)
    confirmSheet('You haven’t saved what you wrote. Leave this page anyway?', 'Leave', 'Stay').then((yes) => { if (yes) { LEAVING = next; go(next) } })
    return
  }
  LEAVING = ''
  page = next
  UNSAVED = null
  if (page.startsWith('agent/')) saw(page.split('/')[1])
  document.body.classList.remove('nav-open')
  if (TOKEN) start(); else locked(LOCKED)
  render()
}
// `cage ui` opens this page with a one-time pairing code, which is traded here for the token the page keeps. The
// token itself never goes in an address (other programs on this computer could read it there). An address with the
// token in it (from an older cage) still works, but only a token that works replaces the one kept here: any website
// could send you to this page with a made-up one.
let LOCKED = ''   // why this page can't open, when it can't
let LEAVING = ''  // the page you said you'd leave unsaved text for
async function signIn (raw) {
  let t = ''
  try {
    if (raw.startsWith('pair=')) {
      const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: raw.slice(5) }) })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.token) t = d.token
      else if (!TOKEN) LOCKED = d.error || ''
    } else if ((await fetch('/api/state', { headers: { 'X-Cage-Token': raw } })).ok) t = raw
  } catch (e) { if (!TOKEN) LOCKED = NOT_ANSWERING }
  if (!t) return
  TOKEN = t
  LOCKED = ''
  try { localStorage.setItem('cage-token', t) } catch (e) {}
}
let started = false
function start () {
  if (started) return
  started = true
  refresh().then(reattach)
  setTimeout(() => { // the first answer can take a while just after the computer wakes up
    const el = !STATE && document.querySelector('#main .loading')
    if (el) el.textContent = 'Still starting… This can take a minute after your computer wakes up.'
  }, 8000)
  api('/api/update').then((d) => { LATEST = d.latest || ''; render() }).catch(() => {})
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})
  setInterval(() => { if (!dlg.open && document.visibilityState === 'visible') refresh() }, 6000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (page.startsWith('agent/')) saw(page.split('/')[1])
    if (!dlg.open) refresh()
  })
  window.addEventListener('beforeunload', (e) => { if (unsaved()) { e.preventDefault(); e.returnValue = '' } })
}
async function reattach () { // after a reload: a job this page started is still going; it comes back as the pill
  try {
    const list = (await api('/api/jobs')).jobs || []
    if (OLD) { OLD = false; notice('') }
    const j = list[list.length - 1]
    if (j && !job) openJob(j.id, j.args, j.title, false)
  } catch (e) { // a web app without that list predates this page (it went on through an update): see OLD
    if (e.status === 404) { OLD = true; notice('old') }
  }
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
document.getElementById('jump').addEventListener('click', () => { document.body.classList.remove('nav-open'); openPalette() })
if (MAC) document.getElementById('jump-key').textContent = '⌘K'
