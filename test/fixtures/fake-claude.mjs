#!/usr/bin/env node
// A stand-in for the `claude` CLI as cc-connect drives it (stream-json in and out), for test/cc-chat.mjs. It notes
// how it was started and every message it gets (its text, and how many pictures came with it) in $FAKE_CLAUDE_LOG,
// one JSON object per line, and answers each message with "ok: <the message>", one at a time. A message that starts
// with "Take your time" keeps it busy for 3 seconds first.
import fs from 'node:fs'
import readline from 'node:readline'

const note = (o) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const SID = `fake-${process.pid}`
note({ args: process.argv.slice(2) })

const queue = []
let busy = false
async function run () {
  busy = true
  while (queue.length) {
    const text = queue.shift()
    out({ type: 'system', subtype: 'init', session_id: SID, model: 'fake' })
    if (text.startsWith('Take your time')) await new Promise((resolve) => setTimeout(resolve, 3000))
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok: ' + text }] }, session_id: SID })
    out({ type: 'result', subtype: 'success', result: '', session_id: SID, usage: {} })
  }
  busy = false
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.type !== 'user') return
  const c = m.message?.content
  const parts = Array.isArray(c) ? c : []
  const text = typeof c === 'string' ? c : parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
  note({ message: text, images: parts.filter((x) => x.type === 'image').length })
  queue.push(text)
  if (!busy) run()
})
rl.on('close', () => process.exit(0))   // cc-connect is gone
