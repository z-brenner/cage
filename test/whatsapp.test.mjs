// Unit tests for the WhatsApp adapter's rules (who may reach the agent), without WhatsApp: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accept, textOf, audioOf, digits, toWhatsApp } from '../guest/whatsapp.mjs'

const me = { pn: '15550001111@s.whatsapp.net', lid: '987654321@lid' }
const base = { mode: 'spare', allow: ['15552223333'], me, sent: new Set(), since: 1000, mark: '[•|•] Claude:' }
const msg = (key, text = 'hi', ts = 2000) => ({ key: { id: 'M1', ...key }, message: { conversation: text }, messageTimestamp: ts })

test('spare number: only the allowed phone number gets through', () => {
  assert.deepEqual(accept(msg({ remoteJid: '15552223333@s.whatsapp.net' }), base), { chat: '15552223333@s.whatsapp.net', user: '15552223333' })
  assert.equal(accept(msg({ remoteJid: '15559999999@s.whatsapp.net' }), base), null)
})

test('spare number: privacy ids (LIDs) are matched through the phone-number alternative', () => {
  const m = msg({ remoteJid: '111222@lid', remoteJidAlt: '15552223333@s.whatsapp.net' })
  assert.deepEqual(accept(m, base), { chat: '111222@lid', user: '15552223333' })
  assert.equal(accept(msg({ remoteJid: '111222@lid' }), base), null)   // no phone number known: refused
})

test('spare number: ignores its own messages, groups, broadcasts, history and non-text', () => {
  assert.equal(accept(msg({ remoteJid: '15552223333@s.whatsapp.net', fromMe: true }), base), null)
  assert.equal(accept(msg({ remoteJid: '123-456@g.us', participant: '15552223333@s.whatsapp.net' }), base), null)
  assert.equal(accept(msg({ remoteJid: 'status@broadcast' }), base), null)
  assert.equal(accept(msg({ remoteJid: '15552223333@s.whatsapp.net' }, 'old', 10), base), null)
  assert.equal(accept({ key: { id: 'X', remoteJid: '15552223333@s.whatsapp.net' }, message: { stickerMessage: {} } }, base), null)
  const sent = new Set(['M1'])
  assert.equal(accept(msg({ remoteJid: '15552223333@s.whatsapp.net' }), { ...base, sent }), null)
})

test('own number: only the "Message yourself" chat, only messages the owner sent', () => {
  const own = { ...base, mode: 'own', allow: [] }
  assert.deepEqual(accept(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), own), { chat: '15550001111@s.whatsapp.net', user: 'me' })
  assert.deepEqual(accept(msg({ remoteJid: '987654321@lid', fromMe: true }), own), { chat: '987654321@lid', user: 'me' })
  assert.equal(accept(msg({ remoteJid: '15552223333@s.whatsapp.net', fromMe: true }), own), null)   // a chat with someone else
  assert.equal(accept(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: false }), own), null)
  assert.equal(accept(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }, '[•|•] Claude: done'), own), null)
})

test('timestamps can be protobuf Longs', () => {
  const long = { low: 2000, high: 0, toNumber() { return 2000 } }
  assert.ok(accept({ ...msg({ remoteJid: '15552223333@s.whatsapp.net' }), messageTimestamp: long }, base))
})

test('helpers', () => {
  assert.equal(digits('15550001111:12@s.whatsapp.net'), '15550001111')
  assert.equal(textOf({ message: { extendedTextMessage: { text: 'x' } } }), 'x')
  assert.equal(textOf({ message: { imageMessage: { caption: 'look' } } }), 'look')
  assert.equal(toWhatsApp('**bold** and ~~gone~~\n## Title'), '*bold* and ~gone~\n*Title*')
})

test('voice notes get through from the same people text does, and nobody else', () => {
  const voice = (key) => ({ key: { id: 'V1', ...key }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 4, ptt: true } }, messageTimestamp: 2000 })
  assert.equal(audioOf(voice({ remoteJid: 'x' })).seconds, 4)
  assert.deepEqual(accept(voice({ remoteJid: '15552223333@s.whatsapp.net' }), base), { chat: '15552223333@s.whatsapp.net', user: '15552223333' })
  assert.equal(accept(voice({ remoteJid: '15559999999@s.whatsapp.net' }), base), null)
  assert.equal(audioOf(msg({ remoteJid: 'x' })), null)
})
