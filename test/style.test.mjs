// The web app's colours (host/ui/static/style.css): text that's readable, in light and dark. axe-core can't tell on a
// page whose background is a gradient (Home's, on a wide window), so this reads the stylesheet itself.
//   node --test test/style.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const css = fs.readFileSync(new URL('../host/ui/static/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, k, v]) => [k, v]))
const light = tokens(/:root\s*\{([^}]*)\}/.exec(css)[1])
const dark = { ...light, ...tokens(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)[1]) }
// WCAG 2's contrast ratio of two #rrggbb colours
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

test('the colours of text read at 4.5:1 or more on every background, in light and dark', () => {
  for (const [scheme, t] of [['light', light], ['dark', dark]]) {
    for (const fg of ['ink', 'fg', 'muted']) {
      for (const bg of ['bg', 'sidebar', 'card', 'raised']) {
        assert.ok(t[fg] && t[bg], `no --${fg} or --${bg} in the ${scheme} colours`)
        const r = ratio(t[fg], t[bg])
        assert.ok(r >= 4.5, `${scheme}: --${fg} (${t[fg]}) on --${bg} (${t[bg]}) is ${r.toFixed(2)}:1`)
      }
    }
  }
})

// --faint is lighter than that (2.5:1 in light): for icons and lines, never for words. Each rule that colours
// something with it is one of these, whose text (if any) has a colour of its own.
const ICONS = new Set(['.i.muted', '#nav .nav-add', '.empty-state .i', '.chev', '.pal-search'])
test('nothing with words in it is coloured --faint', () => {
  const faint = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /(^|[;\s])color:\s*var\(--faint\)/.test(body))
    .flatMap(([, sel]) => sel.split(',').map((s) => s.trim()))
  assert.ok(faint.length, 'found no rule coloured --faint; update this test')
  const words = faint.filter((s) => !ICONS.has(s))
  assert.deepEqual(words, [], 'text coloured --faint (use --muted): ' + words.join(', '))
})
