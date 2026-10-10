// Style You service worker: works offline, receives shares on Android, and installs new versions as a whole.
// App files are served from this version's cache, so a page never mixes old and new files. A new version
// (a changed VERSION below) downloads in the background and the page shows "New version – tap to update".
const VERSION = '6.4.2';
const CACHE = `styleyou-${VERSION}`;
const CORE = [
  './', 'index.html', 'app.js', 'apple-touch-icon.png', 'figtree-latin-400-normal.woff2', 'figtree-latin-600-normal.woff2', 'figtree-latin-700-normal.woff2', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon.svg', 'manifest.webmanifest', 'manrope-latin-400-normal.woff2', 'manrope-latin-600-normal.woff2', 'manrope-latin-700-normal.woff2', 'sc-mix.png', 'sc-occasion.png', 'sc-today.png', 'styles.css'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))));
  // No skipWaiting here: the page shows "New version – tap to update" and the user decides.
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('styleyou-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

async function fromCache(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

// ---------- Android share target ----------
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('styleyou', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('inbox')) d.createObjectStore('inbox', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = [];
    const MAX_FILE = 25 * 1024 * 1024, MAX_TOTAL = 40 * 1024 * 1024;
    let total = 0, rejected = 0;
    for (const f of form.getAll('files')) {
      if (!f || typeof f !== 'object' || !/^image\//.test(f.type)) continue;
      if (f.size > MAX_FILE || files.length >= 4 || total + f.size > MAX_TOTAL) { rejected++; continue; }
      total += f.size; files.push({ name: String(f.name || 'shared.jpg').slice(0, 80), type: f.type, blob: f });
    }
    const warning = rejected ? `\nSTYLEYOU_SHARE_WARNING: ${rejected} image${rejected === 1 ? '' : 's'} not imported because the share was too large. Try fewer or smaller images.` : '';
    const entry = { id: `in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), title: String(form.get('title') || '').slice(0, 500), text: (String(form.get('text') || '').slice(0, 49000) + warning).slice(0, 50000), url: String(form.get('url') || '').slice(0, 2000), files };
    const db = await openDB();
    await new Promise((res, rej) => { const t = db.transaction('inbox', 'readwrite'); t.objectStore('inbox').put(entry); t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close();
  } catch (e) { /* fall through to the app; nothing to show */ }
  return Response.redirect(new URL('./#/home', self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET' || url.origin !== location.origin) return; // weather and AI links go straight to the network
  e.respondWith(fromCache(req));
});
