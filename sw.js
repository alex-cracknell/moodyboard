// Service worker: makes the app work offline and receives items shared from other apps.
// Bump VERSION whenever you change any app file so phones pick up the update.
const VERSION = 'moodboard-v1.2.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/db.js',
  './js/zip.js',
  './js/util.js',
  './js/icons.js',
  './js/ui.js',
  './js/store.js',
  './js/cards.js',
  './js/canvas.js',
  './js/editors.js',
  './js/backup.js',
  './js/backup-ui.js',
  './js/home.js',
  './js/config.js',
  './js/drive.js',
  './js/sync.js',
  './js/sync-ui.js',
  './js/clipboard.js',
  './fonts/bricolage-grotesque-latin-standard-normal.woff2',
  './fonts/bricolage-grotesque-latin-ext-standard-normal.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Web Share Target: another app shared something to us.
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // App files: cache first, falling back to the network (and caching what we get).
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const isPage = event.request.mode === 'navigate';
    const hit = await cache.match(isPage ? './index.html' : event.request, { ignoreSearch: isPage });
    if (hit) return hit;
    try {
      const res = await fetch(event.request);
      if (res.ok && res.type === 'basic') cache.put(event.request, res.clone());
      return res;
    } catch {
      return isPage ? cache.match('./index.html') : Response.error();
    }
  })());
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(f => f && typeof f !== 'string' && f.size);
    const item = {
      at: Date.now(),
      title: form.get('title') || '',
      text: form.get('text') || '',
      url: form.get('url') || '',
      files: files.map(f => new File([f], f.name || 'shared', { type: f.type })),
    };
    await putInbox(item);
  } catch (e) {
    // Fall through to the app; it will just show nothing new.
  }
  const scope = self.registration.scope;
  return Response.redirect(`${scope}?shared=1`, 303);
}

function putInbox(item) {
  return new Promise((resolve, reject) => {
    // No version number: open whatever version the app has created.
    const req = indexedDB.open('moodboard');
    req.onupgradeneeded = () => {
      const db = req.result;
      // Same schema as js/db.js, in case the share arrives before the app ever opened.
      if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'id' }).createIndex('parentId', 'parentId');
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' }).createIndex('boardId', 'boardId');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('inbox', 'readwrite');
      tx.objectStore('inbox').add(item);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}
