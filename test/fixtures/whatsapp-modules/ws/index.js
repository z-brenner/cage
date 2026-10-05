// Stand-in for the ws package in test/whatsapp.test.mjs: the few calls the adapter makes, on Node's own WebSocket.
// Like ws, a connection that fails says 'error' and then 'close' (Node's own says only 'error').
import { EventEmitter } from 'node:events'

export default class WebSocket extends EventEmitter {
  static OPEN = 1
  constructor (url, { headers } = {}) {
    super()
    this.ended = false
    this.ws = new globalThis.WebSocket(url, { headers })
    this.ws.addEventListener('open', () => this.emit('open'))
    this.ws.addEventListener('message', (e) => this.emit('message', Buffer.from(String(e.data))))
    this.ws.addEventListener('close', () => this.end())
    this.ws.addEventListener('error', () => { this.emit('error', new Error('websocket error')); this.end() })
  }

  end () { if (!this.ended) { this.ended = true; this.emit('close') } }
  get readyState () { return this.ended ? 3 : this.ws.readyState }
  send (data) { this.ws.send(data) }
  close () { this.ws.close() }
}
