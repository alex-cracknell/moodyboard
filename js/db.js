// IndexedDB storage. Everything the app keeps lives here, on the device.
const DB_NAME = 'moodboard';
const DB_VERSION = 1;
export const STORES = ['boards', 'cards', 'blobs', 'meta', 'inbox'];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('boards')) {
        const s = db.createObjectStore('boards', { keyPath: 'id' });
        s.createIndex('parentId', 'parentId');
      }
      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('boardId', 'boardId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      // Items shared into the app from other apps, waiting to be placed on a board.
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

export async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; }).catch(err => { try { t.abort(); } catch {} reject(err); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export async function get(store, key) {
  return tx([store], 'readonly', t => reqP(t.objectStore(store).get(key)));
}
export async function getAll(store) {
  return tx([store], 'readonly', t => reqP(t.objectStore(store).getAll()));
}
export async function getByIndex(store, index, value) {
  return tx([store], 'readonly', t => reqP(t.objectStore(store).index(index).getAll(value)));
}
export async function put(store, value) {
  return tx([store], 'readwrite', t => reqP(t.objectStore(store).put(value)));
}
export async function del(store, key) {
  return tx([store], 'readwrite', t => reqP(t.objectStore(store).delete(key)));
}
export async function getAllKeys(store) {
  return tx([store], 'readonly', t => reqP(t.objectStore(store).getAllKeys()));
}

// Apply a list of changes atomically: [{store, id, value}] where value null = delete.
export async function applyChanges(changes) {
  if (!changes.length) return;
  const stores = [...new Set(changes.map(c => c.store))];
  return tx(stores, 'readwrite', t => {
    for (const c of changes) {
      const s = t.objectStore(c.store);
      if (c.value == null) s.delete(c.id); else s.put(c.value);
    }
  });
}

export async function clearAll(stores = ['boards', 'cards', 'blobs']) {
  return tx(stores, 'readwrite', t => { for (const s of stores) t.objectStore(s).clear(); });
}

// ---- settings (meta store) ----
export const DEFAULT_SETTINGS = {
  theme: 'system',            // system | light | dark
  snap: true,                 // snap cards to grid
  optimiseImages: true,       // shrink large photos when adding
  reminderEnabled: true,
  reminderDays: 7,
  lastBackupAt: 0,
  lastChangeAt: 0,
  reminderSnoozedUntil: 0,
  firstUseAt: 0,
};

let settingsCache = null;
export async function getSettings() {
  if (settingsCache) return settingsCache;
  const row = await get('meta', 'settings');
  settingsCache = { ...DEFAULT_SETTINGS, ...(row ? row.value : {}) };
  return settingsCache;
}
export async function saveSettings(patch) {
  const s = await getSettings();
  Object.assign(s, patch);
  await put('meta', { key: 'settings', value: s });
  return s;
}

export async function getBlob(id) {
  const row = await get('blobs', id);
  return row ? row.blob : null;
}

// ids: time-sortable and random enough for one device plus merges from others.
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
