import * as db from './db.js';
import { createZip, readZip } from './zip.js';
import { state, collectSubtree, blobRefs, loadBoards, getTombstones, saveTombstones } from './store.js';
import { extForMime } from './util.js';

const FORMAT = 'moodboard-backup';
const VERSION = 1;

// Build a backup zip. boardId = null backs up everything; otherwise just that board and what's inside it.
export async function buildBackup(boardId = null, onProgress) {
  let boards, cards;
  if (boardId) {
    ({ boards, cards } = await collectSubtree(boardId));
    boards = boards.map(b => (b.id === boardId ? { ...b, parentId: null } : b));
  } else {
    [boards, cards] = await Promise.all([db.getAll('boards'), db.getAll('cards')]);
  }
  const ids = new Set();
  for (const r of [...boards, ...cards]) for (const id of blobRefs(r)) ids.add(id);
  const blobMeta = [];
  const entries = [];
  for (const id of ids) {
    const row = await db.get('blobs', id);
    if (!row) continue;
    const path = `files/${id}.${extForMime(row.type || row.blob.type)}`;
    blobMeta.push({ id, type: row.type || row.blob.type, name: row.name || '', path });
    entries.push({ name: path, data: row.blob });
  }
  const settings = await db.getSettings();
  const manifest = {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
    scope: boardId ? 'board' : 'all', rootBoardId: boardId,
    counts: { boards: boards.length, cards: cards.length, files: blobMeta.length },
    settings: boardId ? undefined : {
      theme: settings.theme, snap: settings.snap, optimiseImages: settings.optimiseImages,
      reminderEnabled: settings.reminderEnabled, reminderDays: settings.reminderDays,
    },
    boards, cards, blobs: blobMeta,
  };
  entries.unshift({ name: 'manifest.json', data: JSON.stringify(manifest) });
  const zip = await createZip(entries, onProgress);
  const name = boardId ? (state.boards.get(boardId)?.name || 'board') : 'moodboard-backup';
  return { blob: zip, filename: `${safeName(name)}-${stamp()}.zip`, counts: manifest.counts };
}

function safeName(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'board'; }
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------- ways to put the file somewhere ----------
export const canPickSaveLocation = () => typeof window.showSaveFilePicker === 'function';

export function canShareFile(blob, filename) {
  try {
    const f = new File([blob], filename, { type: 'application/zip' });
    return !!(navigator.canShare && navigator.canShare({ files: [f] }));
  } catch { return false; }
}

export async function saveWithPicker(blob, filename) {
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: 'Moodboard backup', accept: { 'application/zip': ['.zip'] } }],
  });
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

export async function shareFile(blob, filename) {
  const f = new File([blob], filename, { type: 'application/zip' });
  await navigator.share({ files: [f], title: filename });
}

export function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function markBackedUp() {
  await db.saveSettings({ lastBackupAt: Date.now(), reminderSnoozedUntil: 0 });
}

// ---------- import ----------
export async function inspectBackup(file) {
  const files = await readZip(file);
  const mf = files.get('manifest.json');
  if (!mf) throw new Error('This zip is not a moodboard backup (manifest.json is missing).');
  let manifest;
  try { manifest = JSON.parse(await (await mf()).text()); } catch { throw new Error('The backup manifest could not be read.'); }
  if (manifest.format !== FORMAT) throw new Error('This zip is not a moodboard backup.');
  if (manifest.version > VERSION) throw new Error('This backup was made by a newer version of the app. Update the app and try again.');
  return { files, manifest };
}

// mode: 'merge' (add and update, keep everything else) | 'replace' (wipe first)
export async function restoreBackup({ files, manifest }, mode, onProgress) {
  let boards = manifest.boards || [], cards = manifest.cards || [];
  const blobs = manifest.blobs || [];
  if (mode === 'replace') {
    // Record what's being wiped so Drive sync removes it on other devices too,
    // and stamp the restored boards as newest so they win.
    const keep = new Set([...boards, ...cards].map(r => r.id));
    const [oldBoards, oldCards] = await Promise.all([db.getAll('boards'), db.getAll('cards')]);
    const tombs = await getTombstones();
    const now = Date.now();
    for (const r of oldBoards) if (!keep.has(r.id)) tombs[r.id] = { store: 'boards', at: now };
    for (const r of oldCards) if (!keep.has(r.id)) tombs[r.id] = { store: 'cards', at: now };
    for (const id of keep) delete tombs[id];
    await saveTombstones(tombs);
    boards = boards.map(b => ({ ...b, updated: now }));
    cards = cards.map(c => ({ ...c, updated: now }));
    await db.clearAll(['boards', 'cards', 'blobs']);
  }
  let done = 0;
  const total = blobs.length;
  // Files first, in small batches so one huge transaction doesn't stall the phone.
  const BATCH = 8;
  for (let i = 0; i < blobs.length; i += BATCH) {
    const rows = [];
    for (const b of blobs.slice(i, i + BATCH)) {
      const getter = files.get(b.path);
      if (!getter) continue;
      let blob = await getter();
      if (b.type && blob.type !== b.type) blob = new Blob([blob], { type: b.type });
      rows.push({ store: 'blobs', id: b.id, value: { id: b.id, blob, type: b.type, name: b.name, size: blob.size, created: Date.now() } });
    }
    await db.applyChanges(rows);
    done += rows.length;
    onProgress && onProgress(done, total);
  }
  await db.applyChanges([
    ...boards.map(b => ({ store: 'boards', id: b.id, value: b })),
    ...cards.map(c => ({ store: 'cards', id: c.id, value: c })),
  ]);
  if (mode === 'replace' && manifest.settings) await db.saveSettings(manifest.settings);
  await loadBoards();
  return { boards: boards.length, cards: cards.length, files: done };
}

// ---------- reminder ----------
export const REMINDER_OPTIONS = [
  { days: 1, label: 'Every day' },
  { days: 3, label: 'Every 3 days' },
  { days: 7, label: 'Every week' },
  { days: 14, label: 'Every 2 weeks' },
  { days: 30, label: 'Every month' },
];

export async function reminderDue() {
  const s = await db.getSettings();
  if (!s.reminderEnabled) return false;
  const now = Date.now();
  if (s.reminderSnoozedUntil && now < s.reminderSnoozedUntil) return false;
  if (!state.boards.size) return false;
  // Nothing has changed since the last backup: no need to nag.
  if (s.lastBackupAt && s.lastChangeAt && s.lastChangeAt <= s.lastBackupAt) return false;
  const since = s.lastBackupAt || s.firstUseAt || now;
  return now - since >= s.reminderDays * 86400_000;
}

export async function snoozeReminder() {
  // Dismissed: ask again tomorrow (or at the next interval if that is sooner).
  const s = await db.getSettings();
  const wait = Math.min(1, s.reminderDays) * 86400_000;
  await db.saveSettings({ reminderSnoozedUntil: Date.now() + wait });
}
