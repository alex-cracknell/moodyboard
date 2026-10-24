// Sync with Google Drive: newest edit wins, per card and per board.
//
// Drive layout (a normal, visible folder in the person's Drive):
//   Moodboard/
//     moodboard-data.json   every board and card (text only) + deletion records + file index
//     files/                one Drive file per image, sketch, voice note or attachment
//     backups/              weekly full backup zips (newest few kept)
//     shared/               board copies made with "Share a copy"
import * as drive from './drive.js';
import * as db from './db.js';
import { state, subscribe, applyRemote, getTombstones, saveTombstones, blobRefs, loadBoards } from './store.js';
import { buildBackup } from './backup.js';
import { extForMime } from './util.js';

const DATA_NAME = 'moodboard-data.json';
const ROOT_NAME = 'Moodboard';
const KEEP_BACKUPS = 4;
const WEEK = 7 * 86400_000;
const POLL_MS = 60_000;

// ---------- status ----------
const status = { state: 'off', message: '', lastSyncAt: 0, progress: '' };
const statusListeners = new Set();
export function onStatus(fn) { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); }
function setStatus(patch) {
  Object.assign(status, patch);
  for (const fn of statusListeners) fn(status);
}
export const getStatus = () => status;

async function syncSettings() {
  const s = await db.getSettings();
  return s.sync || null;
}
async function saveSync(patch) {
  const s = await db.getSettings();
  await db.saveSettings({ sync: { ...(s.sync || {}), ...patch } });
}

export const isConfigured = () => drive.driveConfigured();
export async function isConnected() { return !!(await syncSettings())?.connected; }

// ---------- connect / disconnect ----------
export async function connect() {
  setStatus({ state: 'syncing', message: 'Connecting to Google Drive…' });
  try {
    await drive.signIn({ consent: false });
    const me = await drive.whoAmI();
    await saveSync({ connected: true, email: me.emailAddress || '', name: me.displayName || '', weeklyBackup: true, folderId: null, dataFileId: null, remoteVersion: null, lastSig: null });
    await runSync();
  } catch (e) {
    const s = await syncSettings();
    setStatus({ state: s?.connected ? 'error' : 'off', message: friendly(e) });
    throw e;
  }
}

export async function disconnect() {
  await drive.signOut();
  const s = await db.getSettings();
  const prev = s.sync || {};
  await db.saveSettings({ sync: { connected: false, weeklyBackup: prev.weeklyBackup !== false } });
  await db.put('meta', { key: 'syncFiles', value: {} });
  setStatus({ state: 'off', message: '', lastSyncAt: 0 });
}

// Tap on the sync button / "Sync now".
export async function syncNow() {
  const s = await syncSettings();
  if (!s?.connected) return;
  if (!drive.hasValidToken()) {
    try { await drive.signIn({ hint: s.email }); }
    catch (e) { setStatus({ state: 'needs-auth', message: friendly(e) }); return; }
  }
  await runSync();
}

function friendly(e) {
  if (!navigator.onLine) return 'You’re offline. Changes will sync when you’re back online.';
  if (e instanceof drive.AuthError) return e.message;
  return e?.message || String(e);
}

// ---------- scheduling ----------
let timer = null, pollTimer = null, running = null, again = false;

export function schedule(ms = 4000) {
  clearTimeout(timer);
  timer = setTimeout(() => { autoSync(); }, ms);
}

async function autoSync() {
  const s = await syncSettings();
  if (!s?.connected) return;
  if (!navigator.onLine) { setStatus({ state: 'offline', message: 'Offline. Changes will sync when you’re back online.' }); return; }
  if (!drive.hasValidToken()) { setStatus({ state: 'needs-auth', message: 'Tap to sync with Google Drive' }); return; }
  await runSync().catch(() => {});
}

let started = false;
export async function initSync() {
  if (!drive.driveConfigured()) { setStatus({ state: 'unavailable' }); return; }
  const s = await syncSettings();
  if (s?.connected) {
    const ok = drive.hasValidToken();
    setStatus({ lastSyncAt: s.lastSyncAt || 0, state: ok ? 'idle' : 'needs-auth', message: ok ? '' : 'Tap to sync with Google Drive' });
  } else setStatus({ state: 'off' });
  if (started) return;
  started = true;
  // Local edits → sync a few seconds later.
  subscribe((changes, meta) => { if (meta?.kind !== 'sync') schedule(4000); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(400); });
  window.addEventListener('online', () => schedule(500));
  window.addEventListener('offline', async () => { if (await isConnected()) setStatus({ state: 'offline', message: 'Offline. Changes will sync when you’re back online.' }); });
  // Pick up changes from the other device while the app is open.
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') autoSync(); }, POLL_MS);
  schedule(800);
}

// ---------- the sync itself ----------
async function runSync() {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do { again = false; await syncOnce(); } while (again);
    } finally { running = null; }
  })();
  return running;
}

const ts = r => (r ? (r.updated || r.created || 0) : -1);

function signature(boards, cards, tombs, files) {
  // Cheap fingerprint of the synced state; if it hasn't changed, nothing is uploaded.
  const parts = [];
  for (const r of [...boards, ...cards]) parts.push(`${r.id}:${ts(r)}`);
  for (const [id, t] of Object.entries(tombs)) parts.push(`x${id}:${t.at}`);
  for (const id of Object.keys(files)) parts.push(`f${id}`);
  parts.sort();
  let h = 0x811c9dc5;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${parts.length}-${h.toString(16)}`;
}

// Newest edit wins. A deletion wins over any edit made before it.
export function merge(local, remote) {
  const out = { boards: [], cards: [], tombs: {}, toLocal: [] };
  const allTombs = { ...remote.tombs };
  for (const [id, t] of Object.entries(local.tombs)) if (!allTombs[id] || allTombs[id].at < t.at) allTombs[id] = t;
  for (const store of ['boards', 'cards']) {
    const L = new Map(local[store].map(r => [r.id, r]));
    const R = new Map(remote[store].map(r => [r.id, r]));
    for (const id of new Set([...L.keys(), ...R.keys()])) {
      const l = L.get(id) || null, r = R.get(id) || null;
      let win = ts(r) > ts(l) ? r : l;
      const t = allTombs[id];
      if (t && win && ts(win) <= t.at) win = null;
      if (win) { out[store].push(win); delete allTombs[id]; }
      if ((win === null) !== (l === null) || (win && l && win !== l && JSON.stringify(win) !== JSON.stringify(l))) {
        out.toLocal.push({ store, id, before: l, after: win });
      }
    }
  }
  out.tombs = allTombs;
  return out;
}

async function ensureLayout(s) {
  let { folderId, filesFolderId, backupsFolderId } = s;
  if (folderId) {
    try { const m = await drive.getMeta(folderId); if (m.trashed) folderId = null; } catch (e) { if (e.status === 404) folderId = null; else throw e; }
  }
  if (!folderId) {
    folderId = await drive.ensureFolder(ROOT_NAME);
    filesFolderId = backupsFolderId = null;
  }
  if (!filesFolderId) filesFolderId = await drive.ensureFolder('files', folderId);
  if (!backupsFolderId) backupsFolderId = await drive.ensureFolder('backups', folderId);
  const patch = { folderId, filesFolderId, backupsFolderId };
  await saveSync(patch);
  return { ...s, ...patch };
}

async function syncOnce() {
  let s = await syncSettings();
  if (!s?.connected) return;
  setStatus({ state: 'syncing', message: 'Syncing…', progress: '' });
  try {
    s = await ensureLayout(s);

    // 1. What's in Drive?
    let dataFileId = s.dataFileId;
    let meta = null;
    if (dataFileId) {
      try { meta = await drive.getMeta(dataFileId); if (meta.trashed) { meta = null; dataFileId = null; } }
      catch (e) { if (e.status === 404) dataFileId = null; else throw e; }
    }
    if (!dataFileId) {
      const f = await drive.findChild(s.folderId, DATA_NAME);
      if (f) { dataFileId = f.id; meta = f; }
    }
    const filesRow = await db.get('meta', 'syncFiles');
    let files = { ...(filesRow?.value || {}) };
    let remote = null;
    if (dataFileId && (!s.remoteVersion || String(meta?.version) !== String(s.remoteVersion) || !filesRow)) {
      const blob = await drive.download(dataFileId);
      remote = JSON.parse(await blob.text());
      if (remote.format !== 'moodboard-sync') throw new Error('The Moodboard folder in Drive contains an unexpected data file.');
      files = remote.files || {};
    }

    // 2. Merge with this device.
    const [lb, lc, lt] = await Promise.all([db.getAll('boards'), db.getAll('cards'), getTombstones()]);
    const local = { boards: lb, cards: lc, tombs: { ...lt } };
    const m = remote
      ? merge(local, { boards: remote.boards || [], cards: remote.cards || [], tombs: remote.tombstones || {} })
      : { boards: lb, cards: lc, tombs: { ...lt }, toLocal: [] };

    // 3. Files: fetch what's missing here, upload what's missing there.
    const needed = new Set();
    for (const r of [...m.boards, ...m.cards]) for (const id of blobRefs(r)) needed.add(id);
    const haveLocal = new Set(await db.getAllKeys('blobs'));
    const toDownload = [...needed].filter(id => !haveLocal.has(id) && files[id]);
    const toUpload = [...needed].filter(id => haveLocal.has(id) && !files[id]);
    let n = 0;
    const total = toDownload.length + toUpload.length;
    const tick = () => { n++; if (total > 2) setStatus({ progress: `${n}/${total}`, message: `Syncing files ${n} of ${total}…` }); };
    for (const id of toDownload) {
      const f = files[id];
      try {
        const blob = await drive.download(f.driveId, f.type);
        await db.put('blobs', { id, blob, type: f.type, name: f.name || '', size: blob.size, created: Date.now() });
      } catch (e) {
        if (e.status === 404) delete files[id]; else throw e;
      }
      tick();
    }
    for (const id of toUpload) {
      const row = await db.get('blobs', id);
      if (!row) continue;
      const type = row.type || row.blob.type || 'application/octet-stream';
      const r = await drive.uploadNew(`${id}.${extForMime(type)}`, s.filesFolderId, row.blob, { blobId: id });
      files[id] = { driveId: r.id, type, name: row.name || '' };
      tick();
    }
    // Files nobody uses any more go to Drive's bin (recoverable for 30 days).
    for (const id of Object.keys(files)) {
      if (!needed.has(id)) { await drive.trash(files[id].driveId); delete files[id]; }
    }

    // 4. Apply the other device's changes here — unless this device changed that record meanwhile.
    if (m.toLocal.length) {
      const fresh = [];
      for (const ch of m.toLocal) {
        const cur = await db.get(ch.store, ch.id);
        if (ts(cur) !== ts(ch.before) || (!!cur !== !!ch.before)) continue;
        fresh.push(ch);
      }
      await applyRemote(fresh);
      if (fresh.some(c => c.store === 'boards')) await loadBoards();
    }
    await saveTombstones(m.tombs);
    await db.put('meta', { key: 'syncFiles', value: files });

    // 5. Upload the merged state if it differs from what Drive has.
    const sig = signature(m.boards, m.cards, m.tombs, files);
    let remoteVersion = s.remoteVersion;
    const remoteSig = remote ? signature(remote.boards || [], remote.cards || [], remote.tombstones || {}, remote.files || {}) : s.lastSig;
    if (!dataFileId || sig !== remoteSig) {
      const doc = {
        format: 'moodboard-sync', version: 1, savedAt: new Date().toISOString(),
        boards: m.boards, cards: m.cards, tombstones: m.tombs, files,
      };
      const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
      const r = dataFileId ? await drive.updateContent(dataFileId, blob) : await drive.uploadNew(DATA_NAME, s.folderId, blob);
      dataFileId = r.id;
      remoteVersion = r.version ?? (await drive.getMeta(dataFileId)).version;
    } else if (meta) {
      remoteVersion = meta.version;
    }
    const now = Date.now();
    await saveSync({ dataFileId, remoteVersion: String(remoteVersion), lastSig: sig, lastSyncAt: now });
    // Everything is safely in Drive, so this counts as a backup for the reminder.
    await db.saveSettings({ lastBackupAt: now, reminderSnoozedUntil: 0 });
    setStatus({ state: 'idle', message: '', progress: '', lastSyncAt: now });
    document.dispatchEvent(new CustomEvent('backup-done'));

    // 6. Weekly full backup zip in Drive.
    const s2 = await syncSettings();
    if (s2.weeklyBackup !== false && now - (s2.lastDriveBackupAt || 0) > WEEK && m.boards.length) {
      // Another device may already have made this week's backup.
      const existing = await drive.list(`'${s2.backupsFolderId}' in parents and trashed = false`, 'id,createdTime').catch(() => []);
      const newest = Math.max(0, ...existing.map(f => Date.parse(f.createdTime) || 0));
      if (now - newest > WEEK) await driveBackupNow(s2).catch(() => {});
      else await saveSync({ lastDriveBackupAt: newest });
    }
  } catch (e) {
    if (e instanceof drive.AuthError) setStatus({ state: 'needs-auth', message: 'Tap to sync with Google Drive', progress: '' });
    else if (!navigator.onLine) setStatus({ state: 'offline', message: 'Offline. Changes will sync when you’re back online.', progress: '' });
    else setStatus({ state: 'error', message: friendly(e), progress: '' });
    throw e;
  }
}

// Full backup zip into Moodboard/backups, keeping the newest few.
export async function driveBackupNow(s) {
  s = s || await syncSettings();
  if (!s?.connected || !s.backupsFolderId) throw new Error('Connect Google Drive first.');
  const { blob, filename } = await buildBackup(null);
  await drive.uploadNew(filename, s.backupsFolderId, blob);
  const all = await drive.list(`'${s.backupsFolderId}' in parents and trashed = false`, 'id,name,createdTime');
  all.sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));
  for (const f of all.slice(KEEP_BACKUPS)) await drive.trash(f.id);
  await saveSync({ lastDriveBackupAt: Date.now() });
}

// "Share a copy": put one board's zip in Drive with a view-only link.
export async function shareBoardCopy(boardId) {
  const s = await syncSettings();
  if (!s?.connected) throw new Error('Connect Google Drive first.');
  if (!drive.hasValidToken()) await drive.signIn({ hint: s.email });
  const layout = await ensureLayout(s);
  const sharedId = await drive.ensureFolder('shared', layout.folderId);
  const { blob, filename } = await buildBackup(boardId);
  const r = await drive.uploadNew(filename, sharedId, blob);
  const link = await drive.shareLink(r.id);
  return { link, filename, size: blob.size };
}

export async function setWeeklyBackup(on) { await saveSync({ weeklyBackup: on }); }
export { syncSettings };
