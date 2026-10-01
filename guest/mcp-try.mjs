// Calls tools on a local MCP server from the shell, to check one works (`cage shell <agent>`, and the e2e tests):
//   node /cage/mcp-try.mjs '<tool calls as JSON: [["tool", {args}], ...]>' <server command> [args...]
// Prints each tool's text result. Exits non-zero if the server can't be started or a call errors.
import { spawn } from 'node:child_process'

const [calls, cmd, ...args] = process.argv.slice(2)
if (!cmd) { console.error('usage: node mcp-try.mjs \'[["browser_navigate",{"url":"https://example.com"}]]\' cage-browser'); process.exit(2) }
const server = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
let id = 0
const waiting = {}
server.stdout.on('data', (d) => {
  buf += d
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    try { const m = JSON.parse(line); if (m.id && waiting[m.id]) waiting[m.id](m) } catch {}
  }
})
server.on('exit', (code) => { console.error(`server exited (${code})`); process.exit(1) })
const rpc = (method, params) => new Promise((resolve) => {
  const n = ++id
  waiting[n] = resolve
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
})
setTimeout(() => { console.error('timed out'); process.exit(1) }, 180000).unref()

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cage', version: '1' } })
console.log(`server: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`)
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
let failed = false
for (const [name, a] of JSON.parse(calls || '[]')) {
  const r = await rpc('tools/call', { name, arguments: a })
  const text = (r.result?.content || []).map((c) => c.text || '').join('\n')
  console.log(`--- ${name}\n${text || JSON.stringify(r.error)}`)
  if (r.error || r.result?.isError) failed = true
}
server.removeAllListeners('exit')
server.kill()
process.exit(failed ? 1 : 0)
