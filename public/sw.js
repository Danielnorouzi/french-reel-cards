// Offline support. Each release is cached as ONE complete set of files, so the app never mixes
// a new page with an old stylesheet. Bump VERSION with every release.
const VERSION = 'reel-cards-v8';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'sm2.js', 'anki.js', 'manifest.webmanifest',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'avatars/dog.webp', 'avatars/penguin.webp', 'avatars/seal.webp', 'avatars/bunny.webp', 'avatars/panda.webp', 'avatars/duck.webp',
  'art/coffee.webp', 'art/standing.webp', 'art/sleeping.webp', 'art/cool.webp', 'art/belly.webp'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so we never store a stale copy
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = e.request.mode === 'navigate' || url.pathname === '/' ? './' : url.pathname.replace(/^\//, '');
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;                      // always the same release, instantly and offline
    try { return await fetch(e.request); }    // anything not in the shell
    catch { return (await cache.match('./')) || Response.error(); }
  })());
});
