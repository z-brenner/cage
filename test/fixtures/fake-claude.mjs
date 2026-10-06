#!/usr/bin/env node
// A stand-in for the `claude` CLI as cc-connect drives it (stream-json in and out), for test/cc-chat.mjs. It notes
// how it was started and every message it gets in $FAKE_CLAUDE_LOG, one JSON object per line, and answers each
// message with "ok: <the message>".
import fs from 'node:fs'
import readline from 'node:readline'

const note = (o) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const SID = `fake-${process.pid}`
note({ args: process.argv.slice(2) })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.type !== 'user') return
  const c = m.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : ''
  note({ message: text })
  out({ type: 'system', subtype: 'init', session_id: SID, model: 'fake' })
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok: ' + text }] }, session_id: SID })
  out({ type: 'result', subtype: 'success', result: '', session_id: SID, usage: {} })
})
rl.on('close', () => process.exit(0))   // cc-connect is gone
