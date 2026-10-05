// A stand-in for cc-connect's bridge (ws://127.0.0.1:<port>/bridge/ws), for test/relay.test.mjs and
// test/whatsapp.test.mjs: node:http's 'upgrade' plus just enough WebSocket framing (RFC 6455) for JSON text
// messages. No packages.
//   const b = await fakeBridge({ ack })   ack: answer register with register_ack ok (default), or false to hold it
//                                         (b.opts.ack changes it later)
//   b.conns          every connection so far: { url, headers, at, frames, send(o), ack(), close(), drop() }
//   b.frame(pred)    waits for a message from an adapter that matches, and returns it
//   b.down(), b.up() stop listening (as while cc-connect restarts), then listen again on the same port
import crypto from 'node:crypto'
import http from 'node:http'

function encode (op, payload) { // server frames go unmasked
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x80 | op, len])
    : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
  return Buffer.concat([head, payload])
}

// Node flags for the adapters under test: they use Node 22's own WebSocket (the VM has Node 22), which Node 20
// keeps behind a flag, so the tests also run where the test machine's Node is older.
export const nodeFlags = typeof globalThis.WebSocket === 'function' ? [] : ['--experimental-websocket']

export const until = async (fn, ms = 5000, what = 'a condition') => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export async function fakeBridge ({ ack = true } = {}) {
  const opts = { ack }
  const conns = []
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end() })
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const c = {
      url: req.url, headers: req.headers, at: Date.now(), frames: [], open: true,
      send: (o) => { if (c.open) socket.write(encode(1, Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)))) },
      ack: () => c.send({ type: 'register_ack', ok: true }),
      close: () => { if (c.open) { socket.write(encode(8, Buffer.from([3, 232]))); c.open = false; socket.end() } },
      drop: () => { c.open = false; socket.destroy() }
    }
    conns.push(c)
    let buf = Buffer.alloc(0)
    let parts = []
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 2) return
        const fin = buf[0] & 128
        const op = buf[0] & 15
        let len = buf[1] & 127
        let at = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4 }
        if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10 }
        const masked = buf[1] & 128
        if (buf.length < at + (masked ? 4 : 0) + len) return
        const mask = masked ? buf.subarray(at, at + 4) : null
        at += masked ? 4 : 0
        const data = Buffer.from(buf.subarray(at, at + len))
        if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
        buf = buf.subarray(at + len)
        if (op === 8) { c.close(); return }
        if (op === 9) { socket.write(encode(10, data)); continue }
        if (op !== 0 && op !== 1) continue
        parts.push(data)
        if (!fin) continue   // more of the same message follows
        let m = null
        try { m = JSON.parse(Buffer.concat(parts).toString()) } catch {}
        parts = []
        c.frames.push(m)
        if (m?.type === 'register' && opts.ack) c.ack()
      }
    })
    socket.on('close', () => { c.open = false })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    opts,
    port,
    url: `ws://127.0.0.1:${port}/bridge/ws`,
    conns,
    last: () => conns[conns.length - 1],
    frames: () => conns.flatMap((c) => c.frames),
    frame: (pred, ms = 5000) => until(() => conns.flatMap((c) => c.frames).find((m) => m && pred(m)), ms, 'a message to the bridge'),
    down: () => new Promise((resolve) => { for (const c of conns) c.drop(); server.close(() => resolve()) }),
    up: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    stop: () => new Promise((resolve) => { for (const c of conns) c.drop(); server.close(() => resolve()) })
  }
}
