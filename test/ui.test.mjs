// Drives cage's web app in a real (headless) browser against a stub msb: the page, its token, a question with a
// hidden answer, a yes/no question, a terminal view, asking your agents, the phone layout, and that nothing works
// without the token.
//   node test/ui.test.mjs <base url> <token> <cage home>
// (test/ui.sh starts the server; needs the `playwright` package and a Chromium.)
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
// PLAYWRIGHT_MODULE: where the playwright package is, when it isn't installed next to this file
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')

const [base, token, home] = process.argv.slice(2)
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
if (!(await card.getByRole('link', { name: '@my_claude_bot' }).count())) fail('no link to the bot')
if (!(await page.locator('#nav-agents a', { hasText: 'Claude Code' }).locator('.dot.ok').count())) fail('no ready dot in the sidebar')
ok('agents: Claude ready with its bot link, in the list and the sidebar; the token is moved out of the address bar')

// ask your agents: the awake ones answer side by side
await page.getByLabel('Question for your agents').fill('capital of France?')
if (await page.locator('.composer input[value=codex]').isEnabled()) fail('an asleep agent can be asked')
await page.getByLabel('Question for your agents').press('Enter')
await page.locator('.answer-card', { hasText: 'Claude Code' }).getByText('Paris').waitFor({ timeout: 15000 })
if (!(await page.locator('.answer-card strong', { hasText: 'the stub' }).count())) fail('the answer is not formatted')
ok('ask your agents: the awake ones answer side by side, formatted')

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
await page.getByRole('heading', { name: 'Claude Code' }).waitFor({ timeout: 10000 })
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
