// cage's web app, installable as an app of its own (a window and a taskbar icon, no browser tabs). It works only
// with cage running on this computer, so nothing else is cached: every request goes to it. The one exception is a
// small page for when cage isn't running (after a restart, say), instead of the browser's "This site can't be reached".
const CACHE = 'cage-offline-1'
self.addEventListener('install', (e) => {
  // What the page sends (answers, Stop, a log closed as you leave) goes straight to cage, past this worker: Chrome
  // drops a request sent while the page closes if it has to come through here (where the browser can say so)
  const direct = e.addRoutes ? e.addRoutes({ condition: { requestMethod: 'POST' }, source: 'network' }).catch(() => {}) : null
  const kept = caches.open(CACHE).then((c) => c.addAll(['offline.html', 'logo.svg'])).catch(() => {})
  e.waitUntil(Promise.all([direct, kept]).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
  .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  .then(() => self.clients.claim())))
self.addEventListener('fetch', (e) => {
  const r = e.request
  const kept = (name) => () => caches.match(name).then((x) => x || Response.error())
  if (r.mode === 'navigate') e.respondWith(fetch(r).catch(kept('offline.html')))
  else if (r.method === 'GET' && new URL(r.url).pathname === '/logo.svg') e.respondWith(fetch(r).catch(kept('logo.svg')))
})
// a notification clicked: back to the app, on the agent's chat
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/#home'
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate ? c.focus().then(() => c.navigate(url)).catch(() => c.focus()) : c.focus(); return }
    return self.clients.openWindow(url)
  }))
})
