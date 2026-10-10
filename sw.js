const CACHE = 'sslivraison-shell-v2';
const SHELL = ['/', '/index.html', '/dashboard.html', '/styles.css', '/dashboard.css', '/shared.js', '/app.js',
  '/dashboard.js', '/pwa.js', '/manifest.webmanifest', '/offline.html', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('sslivraison-shell-') && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim())
));
// Cache uniquement les fichiers publics : aucune réponse Supabase, aucun compte, aucune position.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then((cache) => cache.put(url.pathname, copy))); }
    return response;
  }).catch(async () => (await caches.match(url.pathname)) || (event.request.mode === 'navigate' ? await caches.match('/offline.html') : Response.error())));
});
