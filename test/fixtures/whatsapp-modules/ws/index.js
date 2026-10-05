// Stand-in for the ws package in test/whatsapp.test.mjs: the few calls the adapter makes, on Node's own WebSocket.
import { EventEmitter } from 'node:events'

export default class WebSocket extends EventEmitter {
  static OPEN = 1
  constructor (url, { headers } = {}) {
    super()
    this.ws = new globalThis.WebSocket(url, { headers })
    this.ws.addEventListener('open', () => this.emit('open'))
    this.ws.addEventListener('message', (e) => this.emit('message', Buffer.from(String(e.data))))
    this.ws.addEventListener('close', () => this.emit('close'))
    this.ws.addEventListener('error', () => this.emit('error', new Error('websocket error')))
  }

  get readyState () { return this.ws.readyState }
  send (data) { this.ws.send(data) }
  close () { this.ws.close() }
}
