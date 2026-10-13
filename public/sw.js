// Service worker: offline shell + push notifications for emergency pings.
const CACHE = 'tracker-v12';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/icon.svg', '/manifest.webmanifest', '/icon-192.png', '/vendor/leaflet.js', '/vendor/leaflet.css'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// Network first so updates show straight away; fall back to cache when offline.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}
  const title = data.title || 'Live Tracker';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '', icon: '/icon.svg', badge: '/icon.svg', tag: data.type || 'tracker',
    renotify: true, requireInteraction: data.type === 'ping' && data.urgent !== false,
    vibrate: [500, 200, 500, 200, 1000, 200, 500, 200, 500], data,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (data.type === 'ping') c.postMessage({ type: 'ping', from: data.from, text: data.text, urgent: data.urgent });
      return c.focus();
    }
    return self.clients.openWindow(data.type === 'ping' ? '/?ping=' + encodeURIComponent(data.from || '') + '&msg=' + encodeURIComponent(data.text || '') : '/');
  }));
});
