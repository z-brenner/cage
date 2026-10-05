// The app's chat relay in the VM (guest/app.mjs): the rules that keep what it relays in bounds.
//   node --test test/app.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionKey, sessionOf, safeName, sharedName, buttonsOf, entryOf, inWork, apiAllowed, CAPABILITIES, handles } from '../guest/app.mjs'

test('sessions: the chat, or a named side conversation; nothing else gets in', () => {
  assert.equal(sessionKey('you'), 'app:you:you')
  assert.equal(sessionKey('usage'), 'app:usage:you')
  assert.equal(sessionKey('../x'), 'app:you:you')
  assert.equal(sessionKey(undefined), 'app:you:you')
  assert.equal(sessionOf('app:usage:you'), 'usage')
  assert.equal(sessionOf('telegram:1:1'), 'you')
})

test('file names stay file names', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd')
  assert.equal(safeName('.bashrc'), 'bashrc')
  assert.equal(safeName('Q3 report (final).pdf'), 'Q3 report (final).pdf')
  assert.equal(safeName('a;rm -rf ~.txt'), 'a_rm -rf _.txt')
  assert.equal(safeName(''), 'file')
  assert.equal(safeName('x'.repeat(300) + '.pdf').length, 120)
})

test("buttons, whether cc-connect sends its Go names or the documented ones", () => {
  assert.deepEqual(buttonsOf([[{ Text: 'Allow', Data: 'perm:allow' }, { text: 'Deny', data: 'perm:deny' }], [{ Text: 'x' }]]),
    [[{ text: 'Allow', data: 'perm:allow' }, { text: 'Deny', data: 'perm:deny' }]])
  assert.deepEqual(buttonsOf(null), [])
})

test("what cc-connect sends becomes a log line", () => {
  assert.deepEqual(entryOf({ type: 'reply', session_key: 'app:you:you', reply_ctx: 7, content: 'hi', format: 'markdown' }),
    { t: 'reply', session: 'you', ctx: '7', text: 'hi', format: 'markdown' })
  assert.equal(entryOf({ type: 'buttons', session_key: 'app:you:you', content: 'ok?', buttons: [[{ Text: 'Yes', Data: 'perm:allow' }]] }).buttons[0][0].data, 'perm:allow')
  assert.deepEqual(entryOf({ type: 'update_message', session_key: 'app:you:you', preview_handle: 'p1', content: 'more' }),
    { t: 'update', session: 'you', handle: 'p1', text: 'more' })
  assert.equal(entryOf({ type: 'typing_start', session_key: 'app:you:you' }).on, true)
  assert.equal(entryOf({ type: 'something_new' }), null)
})

test('the work folder: nothing outside it', () => {
  assert.equal(inWork('/home/agent/work', 'reports/q3.txt'), '/home/agent/work/reports/q3.txt')
  assert.equal(inWork('/home/agent/work', ''), '/home/agent/work')
  assert.equal(inWork('/home/agent/work', '/reports'), '/home/agent/work/reports')
  assert.equal(inWork('/home/agent/work', '../.ssh/id_rsa'), null)
  assert.equal(inWork('/home/agent/work', 'a/../../work2'), null)
})

test("cc-connect's management API: only scheduled tasks and status", () => {
  assert.ok(apiAllowed('GET', '/api/v1/cron?project=claude'))
  assert.ok(apiAllowed('POST', '/api/v1/cron'))
  assert.ok(apiAllowed('DELETE', '/api/v1/cron/cron_abc123'))
  assert.ok(apiAllowed('POST', '/api/v1/cron/cron_abc123/exec'))
  assert.ok(!apiAllowed('POST', '/api/v1/restart'))
  assert.ok(!apiAllowed('PATCH', '/api/v1/projects/claude'))
  assert.ok(!apiAllowed('GET', '/api/v1/config'))
  assert.ok(!apiAllowed('PUT', '/api/v1/cron'))
  assert.ok(!apiAllowed('GET', '/api/v1/cron/../config'))
})

test('every kind of message the relay handles is declared to cc-connect', () => {
  // cc-connect v1.5.0 (platform/bridge/bridge.go) sends these only to an adapter that registered the capability
  const needs = { buttons: 'buttons', card: 'card', update_message: 'update_message', preview_start: 'preview',
    delete_message: 'delete_message', typing_start: 'typing', typing_stop: 'typing', audio: 'audio', video: 'video',
    image: 'image', file: 'file' }
  for (const [type, cap] of Object.entries(needs)) {
    if (handles(type)) assert.ok(CAPABILITIES.includes(cap), `the relay handles ${type} but doesn't declare ${cap}`)
  }
  for (const type of ['reply', 'video', 'preview_start', 'image']) assert.ok(handles(type), type)
  assert.ok(!handles('something_new'))
})

test('shared file names: the app strips exactly the <ms>-<rand>- prefix and gets the whole name back', () => {
  const rel = sharedName('q3-results.txt')
  assert.match(rel, /^files\/\d{13}-[0-9a-f]{4}-q3-results\.txt$/)
  assert.equal(rel.slice(6).replace(/^\d+-[0-9a-z]{1,8}-/, ''), 'q3-results.txt')       // host/ui/server.py today
  assert.equal(rel.slice(6).replace(/^\d{10,}-[0-9a-z]{2,8}-/, ''), 'q3-results.txt')   // and its stricter form
  assert.match(sharedName('../../etc/passwd'), /-passwd$/)
})
