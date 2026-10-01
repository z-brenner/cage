// Drives cage's web app in a real (headless) browser against a stub msb: the page, its token, a question with a
// hidden answer, a yes/no question, a terminal view, asking your agents, chatting with one (test/fake-vm.mjs plays
// its VM), the phone layout, and that nothing works without the token.
//   node test/ui.test.mjs <base url> <token> <cage home> <the fake VM's work folder>
// (test/ui.sh starts the server; needs the `playwright` package and a Chromium.)
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
// PLAYWRIGHT_MODULE: where the playwright package is, when it isn't installed next to this file
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')

const [base, token, home, work] = process.argv.slice(2)
let pass = 0
const ok = (m) => { pass++; console.log('ok - ' + m) }
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1) }

const browser = await chromium.launch(process.env.CAGE_TEST_CHROME ? { executablePath: process.env.CAGE_TEST_CHROME } : {})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

// without the token: nothing but the "open it from cage" card
await page.goto(base + '/')
await page.getByText('Open cage from your computer').waitFor({ timeout: 10000 })
ok('without the token, the page shows how to open it, and nothing else')

// with it: the agents
await page.goto(base + '/#' + token)
await page.locator('.agent', { hasText: 'Claude Code' }).getByText('Ready').waitFor({ timeout: 20000 })
if (page.url().includes(token)) fail('the token stayed in the address bar')
const card = page.locator('.agent', { hasText: 'Claude Code' })
if (!(await card.getByRole('link', { name: 'Chat', exact: true }).count())) fail('no way to chat')
if (!(await page.locator('#nav-agents a', { hasText: 'Claude Code' }).locator('.dot.ok').count())) fail('no ready dot in the sidebar')
ok('agents: Claude ready to chat, in the list and the sidebar; the token is moved out of the address bar')

// ask your agents: the awake ones answer side by side
await page.getByLabel('Question for your agents').fill('capital of France?')
if (await page.locator('.composer input[value=codex]').isEnabled()) fail('an asleep agent can be asked')
await page.getByLabel('Question for your agents').press('Enter')
await page.locator('.answer-card', { hasText: 'Claude Code' }).getByText('Paris').waitFor({ timeout: 15000 })
if (!(await page.locator('.answer-card strong', { hasText: 'the stub' }).count())) fail('the answer is not formatted')
ok('ask your agents: the awake ones answer side by side, formatted')

// chat with an agent in the app: a starter, a file, a streamed answer, a file back, asking before acting
await card.getByRole('link', { name: 'Chat', exact: true }).click()
const chat = page.locator('.chat')
await chat.getByRole('button', { name: 'Summarize a document' }).click()
if (!(await chat.locator('textarea').inputValue()).startsWith('Summarize the attached document')) fail('the starter did not fill the message')
fs.writeFileSync(path.join(work, '..', 'brief.pdf'), '%PDF-1.4 brief')
await chat.locator('input[type=file]').setInputFiles(path.join(work, '..', 'brief.pdf'))
await chat.locator('.attached .chip:not(.busy)', { hasText: 'brief.pdf' }).waitFor({ timeout: 10000 })
await chat.locator('textarea').press('Enter')
await chat.locator('.msg-you', { hasText: 'Summarize the attached document' }).locator('.file-chip', { hasText: 'brief.pdf' }).waitFor({ timeout: 10000 })
await chat.locator('.msg-agent', { hasText: 'second point' }).locator('strong', { hasText: 'first' }).waitFor({ timeout: 10000 })
if (await chat.locator('.msg-agent.streaming').count()) fail('the streamed preview stayed after the answer')
const back = chat.locator('.file-chip', { hasText: 'reviewed-brief.pdf' })
await back.waitFor({ timeout: 10000 })
const [download] = await Promise.all([page.waitForEvent('download'), back.click()])
if (fs.readFileSync(await download.path(), 'utf8') !== '%PDF-1.4 brief') fail('the file the agent sent back')
await chat.locator('textarea').fill('Email Bob that the brief is ready')
await chat.locator('textarea').press('Enter')
const approval = chat.locator('.choices.approval')
await approval.getByText('mcp__zapier__gmail_send_email').waitFor({ timeout: 10000 })
await approval.getByRole('button', { name: 'Allow', exact: true }).click()
await chat.getByText('Sent the email to bob@acme.com.').waitFor({ timeout: 10000 })
if (!(await approval.getByText('You chose:').count())) fail('the choice is not shown')
if (!fs.readFileSync(path.join(home, 'app', 'claude', 'log.jsonl'), 'utf8').includes('"action":"perm:allow"')) fail('the approval did not reach the agent')
ok('chat: starters, a file each way, a streamed answer, and asking before acting (Allow reaches the agent)')

// its files and its plan usage
await page.locator('.tabs').getByRole('link', { name: 'Files' }).click()
await page.locator('.card', { hasText: 'notes.md' }).waitFor({ timeout: 15000 })
await page.getByRole('button', { name: 'reports' }).click()
const q3 = page.locator('li', { hasText: 'q3.txt' })
await q3.waitFor({ timeout: 15000 })
const [dl2] = await Promise.all([page.waitForEvent('download'), q3.getByRole('button', { name: 'Download' }).click()])
if (!fs.readFileSync(await dl2.path(), 'utf8').startsWith('Q3: up 12%')) fail('download from the work folder')
if (!(await page.locator('.card', { hasText: 'brief.pdf' }).count())) fail('files of the chat are not listed')
await page.locator('.tabs').getByRole('link', { name: 'Settings' }).click()
await page.locator('.usage').getByText('42% used').waitFor({ timeout: 15000 })
if (!(await page.getByRole('link', { name: '@my_claude_bot' }).count())) fail('no link to the bot in its settings')
ok("files: what you sent each other, and its work folder to download from; its plan's usage in its settings")

// an asleep agent: sending wakes it up, and the message waits in its folder
await page.locator('#nav-agents').getByRole('link', { name: 'Codex' }).click()
await page.locator('.chat-banner', { hasText: 'asleep' }).waitFor({ timeout: 10000 })
await page.locator('.chat textarea').fill('hello codex')
await page.locator('.chat textarea').press('Enter')
await page.locator('.chat-banner', { hasText: 'Waking Codex up' }).waitFor({ timeout: 10000 })
const waiting = fs.readdirSync(path.join(home, 'app', 'codex', 'in')).filter((n) => n.endsWith('.json'))
if (waiting.length !== 1 || !fs.readFileSync(path.join(home, 'app', 'codex', 'in', waiting[0]), 'utf8').includes('hello codex')) fail('the message is not waiting for codex')
ok('an asleep agent wakes up when you message it; the message waits for it')

// a question with a hidden answer: add a key
await page.getByRole('link', { name: 'Sign-ins & keys' }).click()
await page.getByPlaceholder('GITHUB_TOKEN').fill('UI_KEY')
await page.getByPlaceholder('api.github.com').fill('api.ui.example')
await page.getByRole('button', { name: 'Add a key' }).click()
const dialog = page.locator('dialog#job')
const secret = dialog.locator('input[type=password]')
await secret.waitFor({ timeout: 15000 })
await secret.fill('ui-s3cret')
await dialog.getByRole('button', { name: 'Send' }).click()
await dialog.getByText('Done.').waitFor({ timeout: 15000 })
if (!(await dialog.getByText('UI_KEY saved on this computer').count())) fail('no confirmation in the conversation')
if (await dialog.getByText('ui-s3cret').count()) fail('the hidden answer is shown')
if (fs.readFileSync(path.join(home, 'secrets', 'UI_KEY'), 'utf8') !== 'ui-s3cret') fail('the key was not saved')
await dialog.getByRole('button', { name: 'Close' }).click()
await page.locator('.list li', { hasText: 'UI_KEY' }).waitFor({ timeout: 10000 })
ok('a hidden question: the key goes in through the job, is saved, listed, and never shown')

// a yes/no question: /all in chat offers to restart the running agent
await page.getByRole('link', { name: 'Settings' }).click()
await page.locator('.setting', { hasText: 'Ask everyone from chat' }).getByRole('checkbox').check()
await dialog.getByRole('button', { name: 'No' }).waitFor({ timeout: 15000 })
await dialog.getByRole('button', { name: 'No' }).click()
await dialog.getByText('Done.').waitFor({ timeout: 15000 })
if (!/CAGE_ASK_ALL="on"/.test(fs.readFileSync(path.join(home, 'cage.env'), 'utf8'))) fail('/all not turned on')
await dialog.getByRole('button', { name: 'Close' }).click()
ok('a yes/no question: answered with a button; the setting is saved')

// cage mask try: what the vendor would see
await page.getByPlaceholder('Try: email bob@acme.com about Acme').fill('mail bob@example.com')
await page.getByRole('button', { name: 'Preview' }).click()
await dialog.getByText('Done.').waitFor({ timeout: 15000 })
const masked = await dialog.locator('.job-log').innerText()
const term = await dialog.locator('.job-term').innerText().catch(() => '')
if (!/mail \[EMAIL_1\]/.test(masked + term)) fail('mask preview: ' + masked + term)
await dialog.getByRole('button', { name: 'Close' }).click()
ok('the privacy mask preview shows tokens')

// a terminal view: an agent's logs
await page.locator('#nav-agents').getByRole('link', { name: 'Claude Code' }).click()
await page.locator('.tabs').getByRole('link', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Activity log' }).click()
await dialog.locator('.job-term .xterm').waitFor({ timeout: 15000 })
await page.waitForFunction(() => document.querySelector('.job-term')?.innerText.includes('cc-connect: line 3'), null, { timeout: 15000 })
await dialog.getByRole('button', { name: 'Close' }).click()
ok("raw output (an agent's logs) shows in a terminal view")

// Ctrl+K: jump to anything
await page.keyboard.press('Control+k')
await page.locator('dialog#palette input').fill('secur')
await page.keyboard.press('Enter')
await page.getByRole('heading', { name: 'Security' }).waitFor({ timeout: 10000 })
if (await page.locator('dialog#palette[open]').count()) fail('the palette stayed open')
ok('Ctrl+K jumps to a page by name')

// on a phone: the sidebar is a menu
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(300)
if ((await page.locator('#sidebar').boundingBox()).x >= 0) fail('the sidebar covers the page on a phone')
await page.getByRole('button', { name: 'Menu' }).click()
await page.waitForTimeout(400)
if ((await page.locator('#sidebar').boundingBox()).x < 0) fail('the menu does not open')
await page.locator('#nav').getByRole('link', { name: 'Settings' }).click()
await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 10000 })
await page.waitForTimeout(400)
if ((await page.locator('#sidebar').boundingBox()).x >= 0) fail('the menu stays open after picking a page')
ok('on a phone, the sidebar is a menu that closes when you pick a page')

if (errors.length) fail('page errors: ' + errors.join(' | '))
await browser.close()
console.log(`all ${pass} web app tests passed`)
