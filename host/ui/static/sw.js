// cage's web app, installable as an app of its own (a window and a taskbar icon, no browser tabs). It works only
// with cage running on this computer, so nothing is cached: every request goes to it.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
// a notification clicked: back to the app, on the agent's chat
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/#home'
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate ? c.focus().then(() => c.navigate(url)).catch(() => c.focus()) : c.focus(); return }
    return self.clients.openWindow(url)
  }))
})
