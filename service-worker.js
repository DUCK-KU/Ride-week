const cacheName = 'ride-week-v78';
const files = ['./', './index.html', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('ride-week-') && name !== cacheName).map(name => caches.delete(name)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(cacheName).then(async cache => {
    if (event.request.mode === 'navigate') {
      try { const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response; }
      catch { return (await cache.match(event.request)) || cache.match('./index.html'); }
    }
    return (await cache.match(event.request)) || fetch(event.request);
  }));
});
