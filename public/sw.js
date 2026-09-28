// Offline support: the app shell is cached so reviewing works with no connection.
const CACHE = 'reel-cards-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'sm2.js', 'anki.js', 'manifest.webmanifest',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // stale-while-revalidate: answer instantly from cache, refresh in the background
  e.respondWith(caches.open(CACHE).then(async cache => {
    const key = url.pathname === '/' ? './' : e.request;
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(e.request).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
