import * as db from './db.js';

// In-memory state for the app. All writes go through commit(), which applies
// changes to memory and IndexedDB together and records them for undo/redo.
export const state = {
  boards: new Map(),     // every board
  boardId: null,         // board being viewed
  cards: new Map(),      // cards on the current board
  undo: [],
  redo: [],
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(changes, meta) { for (const fn of listeners) fn(changes, meta); }

export async function loadBoards() {
  const all = await db.getAll('boards');
  state.boards = new Map(all.map(b => [b.id, b]));
}

export async function openBoard(id) {
  state.boardId = id;
  const cards = await db.getByIndex('cards', 'boardId', id);
  state.cards = new Map(cards.map(c => [c.id, c]));
  state.undo = [];
  state.redo = [];
}

export function closeBoard() {
  state.boardId = null;
  state.cards = new Map();
  state.undo = [];
  state.redo = [];
}

const clone = v => (v == null ? null : structuredClone(v));

function applyToMemory(store, id, value) {
  if (store === 'boards') {
    if (value) state.boards.set(id, value); else state.boards.delete(id);
  } else if (store === 'cards') {
    if (value && value.boardId === state.boardId) state.cards.set(id, value);
    else state.cards.delete(id);
  }
}

let changeStamp = null;
function noteChange() {
  clearTimeout(changeStamp);
  changeStamp = setTimeout(() => db.saveSettings({ lastChangeAt: Date.now() }), 400);
}

// changes: [{store, id, before, after}]  (before/after null = absent)
export async function commit(changes, { record = true, label = '' } = {}) {
  changes = changes.filter(Boolean).map(c => ({ ...c, before: clone(c.before), after: clone(c.after) }));
  if (!changes.length) return;
  // Touch the board's updated time so the home screen sorts by recent activity.
  const touched = new Set();
  for (const c of changes) {
    const v = c.after || c.before;
    if (c.store === 'cards' && v?.boardId) touched.add(v.boardId);
  }
  for (const bid of touched) {
    const b = state.boards.get(bid);
    if (b && !changes.some(c => c.store === 'boards' && c.id === bid)) {
      changes.push({ store: 'boards', id: bid, before: clone(b), after: { ...clone(b), updated: Date.now() }, silent: true });
    }
  }
  for (const c of changes) applyToMemory(c.store, c.id, c.after);
  await db.applyChanges(changes.map(c => ({ store: c.store, id: c.id, value: c.after })));
  if (record) {
    state.undo.push({ changes, label });
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
  }
  noteChange();
  emit(changes, { kind: 'commit' });
}

export async function undo() {
  const op = state.undo.pop();
  if (!op) return false;
  const rev = op.changes.map(c => ({ store: c.store, id: c.id, value: c.before }));
  for (const c of op.changes) applyToMemory(c.store, c.id, c.before);
  await db.applyChanges(rev);
  state.redo.push(op);
  noteChange();
  emit(op.changes.map(c => ({ ...c, before: c.after, after: c.before })), { kind: 'undo' });
  return op.label || true;
}

export async function redo() {
  const op = state.redo.pop();
  if (!op) return false;
  for (const c of op.changes) applyToMemory(c.store, c.id, c.after);
  await db.applyChanges(op.changes.map(c => ({ store: c.store, id: c.id, value: c.after })));
  state.undo.push(op);
  noteChange();
  emit(op.changes, { kind: 'redo' });
  return op.label || true;
}

// Convenience builders
export const upd = (store, before, after) => ({ store, id: (after || before).id, before, after });
export const cardUpdate = (card, patch) => upd('cards', card, { ...card, ...patch, updated: Date.now() });
export const cardDataUpdate = (card, dataPatch) => cardUpdate(card, { data: { ...card.data, ...dataPatch } });

export function newBoard(name, parentId = null, extra = {}) {
  const now = Date.now();
  return { id: db.uid(), name, parentId, color: null, coverId: null, bg: 'dots', created: now, updated: now, view: null, ...extra };
}

export const DEFAULT_W = {
  note: 240, heading: 320, image: 260, todo: 240, link: 260, column: 280, board: 170,
  swatch: 150, sketch: 260, comment: 240, file: 240, audio: 260, line: 0,
};

export function newCard(type, boardId, x, y, data = {}, extra = {}) {
  const now = Date.now();
  return {
    id: db.uid(), boardId, type, x: Math.round(x), y: Math.round(y), w: DEFAULT_W[type] || 240,
    z: maxZ() + 1, color: null, locked: false, columnId: null, data, created: now, updated: now, ...extra,
  };
}

export function maxZ() {
  let z = 0;
  for (const c of state.cards.values()) if ((c.z || 0) > z) z = c.z;
  return z;
}

export function blobRefs(rec) {
  const out = [];
  if (!rec) return out;
  if (rec.coverId) out.push(rec.coverId);
  const d = rec.data || {};
  if (d.blobId) out.push(d.blobId);
  if (d.thumbId) out.push(d.thumbId);
  return out;
}

// Everything inside a board, including sub-boards, all the way down.
export async function collectSubtree(boardId) {
  const boards = [], cards = [];
  const seen = new Set();
  const walk = async id => {
    if (seen.has(id)) return;
    seen.add(id);
    const b = state.boards.get(id) || await db.get('boards', id);
    if (!b) return;
    boards.push(b);
    const cs = await db.getByIndex('cards', 'boardId', id);
    cards.push(...cs);
    const kids = [...state.boards.values()].filter(x => x.parentId === id);
    for (const k of kids) await walk(k.id);
    for (const c of cs) if (c.type === 'board' && c.data.boardId) await walk(c.data.boardId);
  };
  await walk(boardId);
  return { boards, cards };
}

export async function deleteBoardChanges(boardId) {
  const { boards, cards } = await collectSubtree(boardId);
  return [
    ...boards.map(b => upd('boards', b, null)),
    ...cards.map(c => upd('cards', c, null)),
  ];
}

// Copy a board and everything in it (new ids, copied files). Returns changes and the new root id.
export async function cloneSubtreeChanges(boardId, newParentId, rename) {
  const { boards, cards } = await collectSubtree(boardId);
  const map = new Map();
  const nid = id => { if (!id) return id; if (!map.has(id)) map.set(id, db.uid()); return map.get(id); };
  for (const b of boards) nid(b.id);
  for (const c of cards) nid(c.id);
  const blobMap = new Map();
  for (const r of [...boards, ...cards]) for (const id of blobRefs(r)) if (!blobMap.has(id)) blobMap.set(id, await duplicateBlob(id));
  const nb = id => (id ? blobMap.get(id) || id : id);
  const now = Date.now();
  const changes = [];
  for (const b of boards) {
    const copy = { ...structuredClone(b), id: nid(b.id), coverId: nb(b.coverId), created: now, updated: now };
    copy.parentId = b.id === boardId ? newParentId : (map.get(b.parentId) || b.parentId);
    if (b.id === boardId && rename) copy.name = rename(b.name);
    changes.push(upd('boards', null, copy));
  }
  for (const c of cards) {
    const copy = { ...structuredClone(c), id: nid(c.id), boardId: map.get(c.boardId) || c.boardId, columnId: c.columnId ? map.get(c.columnId) || null : null, created: now, updated: now };
    const d = copy.data || {};
    if (d.blobId) d.blobId = nb(d.blobId);
    if (d.thumbId) d.thumbId = nb(d.thumbId);
    if (c.type === 'board' && d.boardId) d.boardId = map.get(d.boardId) || d.boardId;
    if (c.type === 'column' && d.items) d.items = d.items.map(i => map.get(i) || i);
    if (c.type === 'line') for (const end of ['from', 'to']) if (d[end]?.id) d[end].id = map.get(d[end].id) || d[end].id;
    changes.push(upd('cards', null, copy));
  }
  return { changes, rootId: map.get(boardId) };
}

// Remove stored files that no card or board points at any more.
export async function collectGarbage() {
  const [cards, boards, keys] = await Promise.all([db.getAll('cards'), db.getAll('boards'), db.getAllKeys('blobs')]);
  const used = new Set();
  for (const r of [...cards, ...boards]) for (const id of blobRefs(r)) used.add(id);
  const orphans = keys.filter(k => !used.has(k));
  if (orphans.length) await db.applyChanges(orphans.map(id => ({ store: 'blobs', id, value: null })));
  return orphans.length;
}

// ---------- object URLs for stored files ----------
const urlCache = new Map();
export async function blobUrl(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  const p = db.getBlob(id).then(b => (b ? URL.createObjectURL(b) : null));
  urlCache.set(id, p);
  return p;
}
export function releaseUrls() {
  for (const p of urlCache.values()) p.then(u => u && URL.revokeObjectURL(u));
  urlCache.clear();
}

export async function saveBlob(blob, name = '') {
  const id = db.uid();
  await db.put('blobs', { id, blob, type: blob.type, name, size: blob.size, created: Date.now() });
  return id;
}

export async function duplicateBlob(id) {
  const row = await db.get('blobs', id);
  if (!row) return null;
  const nid = db.uid();
  await db.put('blobs', { ...row, id: nid, created: Date.now() });
  return nid;
}

export function boardPath(id) {
  const path = [];
  let b = state.boards.get(id);
  const seen = new Set();
  while (b && !seen.has(b.id)) {
    seen.add(b.id);
    path.unshift(b);
    b = b.parentId ? state.boards.get(b.parentId) : null;
  }
  return path;
}

export function rootBoards() {
  return [...state.boards.values()].filter(b => !b.parentId).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}
