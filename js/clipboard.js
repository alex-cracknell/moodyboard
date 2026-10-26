// Copy and paste of cards inside the app.
// A copied card is kept as a snapshot (the card, anything inside it, and whole sub-boards),
// so it can be pasted on any board, even after the original has been cut or deleted.
// The snapshot lives in memory and in localStorage (so it also works across tabs);
// the system clipboard gets a small marker plus the card's text for other apps.
import * as db from './db.js';
import { collectSubtree, duplicateBlob, upd, state } from './store.js';
import { sanitizeHtml } from './util.js';

export const CLIP_KEY = 'moodboard-clipboard';
export const CLIP_MIME = 'application/x-moodboard';

let current = null; // { id, text, count, ready: Promise<snapshot> }

function blockText(html) {
  const d = document.createElement('div');
  d.innerHTML = sanitizeHtml(html || '').replace(/<\/?(br|div|p|li|h\d|blockquote)\b[^>]*>/gi, '\n$&');
  return d.textContent.split('\n').map(s => s.trim()).filter(Boolean).join('\n');
}

// Plain text version of a card, for pasting into other apps.
export function cardText(c, children = []) {
  const d = c.data || {};
  switch (c.type) {
    case 'note': return blockText(d.html);
    case 'heading': return d.text || '';
    case 'todo': return [d.title, ...(d.items || []).map(i => `${i.done ? '[x]' : '[ ]'} ${i.text}`)].filter(Boolean).join('\n');
    case 'link': return [d.title && d.title !== d.url ? d.title : '', d.url].filter(Boolean).join('\n');
    case 'swatch': return [d.name, (d.hex || '').toUpperCase()].filter(Boolean).join(' ');
    case 'comment': return (d.entries || []).map(e => e.text).join('\n');
    case 'image': return d.caption || '';
    case 'file': case 'audio': return d.name || '';
    case 'line': return d.label || '';
    case 'board': return state.boards.get(d.boardId)?.name || '';
    case 'column': return [d.title, ...children.map(k => cardText(k))].filter(Boolean).join('\n\n');
    default: return '';
  }
}

// topCards: cards to copy, already in their free-standing form (taken out of any column).
// boardCards: every card on the source board, to find column contents and lines between copied cards.
export function startCopy(sourceBoardId, topCards, boardCards) {
  const id = db.uid();
  const all = [...boardCards.values()];
  const kidsOf = c => all.filter(x => x.columnId === c.id);
  const text = topCards.map(c => cardText(c, c.type === 'column' ? kidsOf(c) : [])).filter(Boolean).join('\n\n');
  const ready = (async () => {
    const byId = new Map(topCards.map(c => [c.id, structuredClone(c)]));
    for (const c of topCards) if (c.type === 'column') for (const k of kidsOf(c)) if (!byId.has(k.id)) byId.set(k.id, structuredClone(k));
    // Lines whose both ends are among the copied cards come along.
    for (const l of all) {
      if (l.type !== 'line' || byId.has(l.id)) continue;
      if (byId.has(l.data.from?.id) && byId.has(l.data.to?.id)) byId.set(l.id, structuredClone(l));
    }
    // Boards inside the copied cards, with everything in them.
    const boards = new Map();
    for (const c of [...byId.values()]) {
      if (c.type !== 'board' || !c.data.boardId) continue;
      const sub = await collectSubtree(c.data.boardId);
      for (const b of sub.boards) boards.set(b.id, b);
      for (const x of sub.cards) if (!byId.has(x.id)) byId.set(x.id, x);
    }
    const snap = { v: 1, id, savedAt: Date.now(), sourceBoardId, text, top: topCards.map(c => c.id), cards: [...byId.values()], boards: [...boards.values()] };
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(snap)); } catch { /* too big for storage: still works in this tab */ }
    return snap;
  })();
  current = { id, text, count: topCards.length, ready };
  return { id, text };
}

let peekCache = null;
// Quick look at what's copied, without loading it all.
export function peekClip() {
  if (current) return { id: current.id, text: current.text, count: current.count };
  if (peekCache) return peekCache;
  try {
    const s = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null');
    if (s?.id) peekCache = { id: s.id, text: s.text || '', count: (s.top || []).length };
  } catch {}
  return peekCache;
}
window.addEventListener('storage', e => { if (e.key === CLIP_KEY) { current = null; peekCache = null; } });

export async function getClip(id) {
  if (current && (!id || current.id === id)) return current.ready;
  try {
    const s = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null');
    if (s && (!id || s.id === id)) return s;
  } catch {}
  return null;
}

// Rough size of what's copied, for finding a free spot.
export function clipSize(snap, estH = {}) {
  const tops = snap.cards.filter(c => snap.top.includes(c.id) && c.type !== 'line');
  if (!tops.length) return { w: 240, h: 120 };
  const x0 = Math.min(...tops.map(c => c.x)), y0 = Math.min(...tops.map(c => c.y));
  const x1 = Math.max(...tops.map(c => c.x + (c.w || 240)));
  const y1 = Math.max(...tops.map(c => c.y + (c.type === 'image' && c.data.w ? (c.w || 260) * c.data.h / c.data.w : (estH[c.type] || 150))));
  return { w: x1 - x0, h: y1 - y0 };
}

// Turn a snapshot into new cards (and boards) on targetBoardId, with their top-left corner at `at`.
export async function pasteChanges(snap, targetBoardId, at, zStart = 1) {
  const src = snap.sourceBoardId;
  const top = new Set(snap.top);
  const now = Date.now();

  // Where the copied group starts, so it can be moved to `at`.
  let minX = Infinity, minY = Infinity;
  for (const c of snap.cards) {
    if (!top.has(c.id)) continue;
    if (c.type === 'line') {
      for (const e of [c.data.from, c.data.to]) if (e && !e.id) { minX = Math.min(minX, e.x); minY = Math.min(minY, e.y); }
    } else { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; }
  const dx = at.x - minX, dy = at.y - minY;

  // Copy the stored files; a card whose file has gone is left out.
  const blobMap = new Map();
  const dup = async id => {
    if (!id) return null;
    if (!blobMap.has(id)) blobMap.set(id, await duplicateBlob(id));
    return blobMap.get(id);
  };
  const boardIds = new Set(snap.boards.map(b => b.id));
  let skipped = 0;
  let keep = [];
  for (const c of snap.cards) {
    const d = c.data || {};
    if (d.blobId && !(await dup(d.blobId))) { skipped++; continue; }
    if (d.thumbId) await dup(d.thumbId);
    if (c.type === 'board' && !boardIds.has(d.boardId)) { skipped++; continue; }
    keep.push(c);
  }
  let kept = new Set(keep.map(c => c.id));
  keep = keep.filter(c => c.type !== 'line' || ['from', 'to'].every(e => !c.data[e]?.id || kept.has(c.data[e].id)));
  kept = new Set(keep.map(c => c.id));

  const map = new Map();
  for (const b of snap.boards) map.set(b.id, db.uid());
  for (const c of keep) map.set(c.id, db.uid());

  const changes = [];
  for (const b of snap.boards) {
    const copy = structuredClone(b);
    copy.id = map.get(b.id);
    copy.parentId = b.parentId === src || !map.has(b.parentId) ? targetBoardId : map.get(b.parentId);
    copy.coverId = b.coverId ? await dup(b.coverId) : null;
    copy.created = copy.updated = now;
    changes.push(upd('boards', null, copy));
  }
  let z = zStart;
  const topIds = [];
  for (const c of keep) {
    const copy = structuredClone(c);
    const d = copy.data || (copy.data = {});
    copy.id = map.get(c.id);
    copy.created = copy.updated = now;
    if (d.blobId) d.blobId = blobMap.get(d.blobId);
    if (d.thumbId) d.thumbId = blobMap.get(d.thumbId) || null;
    if (c.boardId === src) {
      copy.boardId = targetBoardId;
      if (top.has(c.id)) {
        copy.columnId = null;
        copy.z = z++;
        if (c.type === 'line') {
          for (const e of ['from', 'to']) if (d[e] && !d[e].id) d[e] = { x: Math.round(d[e].x + dx), y: Math.round(d[e].y + dy) };
        } else { copy.x = Math.round(c.x + dx); copy.y = Math.round(c.y + dy); }
        topIds.push(copy.id);
      } else {
        copy.columnId = c.columnId && kept.has(c.columnId) ? map.get(c.columnId) : null;
      }
    } else {
      copy.boardId = map.get(c.boardId) || targetBoardId;
      copy.columnId = c.columnId && kept.has(c.columnId) ? map.get(c.columnId) : null;
    }
    if (c.type === 'board') d.boardId = map.get(d.boardId);
    if (c.type === 'column') d.items = (d.items || []).filter(i => kept.has(i)).map(i => map.get(i));
    if (c.type === 'line') for (const e of ['from', 'to']) if (d[e]?.id) d[e] = { id: map.get(d[e].id) };
    changes.push(upd('cards', null, copy));
  }
  return { changes, topIds, skipped };
}
