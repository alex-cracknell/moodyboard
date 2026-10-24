import { h, esc, sanitizeHtml, hostOf, youtubeId, formatBytes, formatDate } from './util.js';
import { icon } from './icons.js';
import { blobUrl, state } from './store.js';
import * as db from './db.js';

export const CARD_COLORS = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'orange', label: 'Orange' },
  { id: 'red', label: 'Red' },
  { id: 'pink', label: 'Pink' },
  { id: 'purple', label: 'Purple' },
  { id: 'blue', label: 'Blue' },
  { id: 'teal', label: 'Teal' },
  { id: 'green', label: 'Green' },
  { id: 'grey', label: 'Grey' },
];

export const TYPE_LABEL = {
  note: 'Note', heading: 'Heading', image: 'Image', todo: 'To-do list', link: 'Link', column: 'Column',
  board: 'Board', swatch: 'Colour', sketch: 'Sketch', comment: 'Comment', file: 'File', audio: 'Voice note', line: 'Line',
};

function setImg(img, id, onload) {
  blobUrl(id).then(u => {
    if (!u) { img.replaceWith(h('div', { class: 'missing' }, 'File missing')); return; }
    img.src = u;
    if (onload) img.onload = onload;
  });
}

export function renderCardContent(card, { editing = false } = {}) {
  const d = card.data || {};
  switch (card.type) {
    case 'note': {
      const body = h('div', { class: 'rich note-body', 'data-placeholder': 'Write something…', html: sanitizeHtml(d.html || '') });
      if (editing) { body.contentEditable = 'true'; body.spellcheck = true; }
      return [body];
    }
    case 'heading': {
      const t = h('div', { class: 'heading-text', 'data-placeholder': 'Heading' });
      t.textContent = d.text || '';
      if (editing) { t.contentEditable = 'plaintext-only'; }
      return [t];
    }
    case 'image': {
      const wrap = h('div', { class: 'img-wrap' });
      if (d.w && d.h) wrap.style.aspectRatio = `${d.w} / ${d.h}`;
      const img = h('img', { alt: d.caption || '', draggable: 'false', decoding: 'async' });
      setImg(img, d.blobId);
      wrap.append(img);
      const out = [wrap];
      if (d.caption) out.push(h('div', { class: 'caption' }, d.caption));
      if (d.source) out.push(h('a', { class: 'source', href: d.source, target: '_blank', rel: 'noopener', 'data-interactive': '' }, hostOf(d.source)));
      return out;
    }
    case 'sketch': {
      const wrap = h('div', { class: 'img-wrap sketch-wrap' });
      if (d.w && d.h) wrap.style.aspectRatio = `${d.w} / ${d.h}`;
      if (d.blobId) { const img = h('img', { alt: 'Sketch', draggable: 'false' }); setImg(img, d.blobId); wrap.append(img); }
      else wrap.append(h('div', { class: 'empty-hint' }, 'Double-tap to draw'));
      return [wrap];
    }
    case 'todo': return renderTodo(card, editing);
    case 'link': return renderLink(card);
    case 'swatch': {
      const hex = d.hex || '#cccccc';
      return [
        h('div', { class: 'swatch-chip', style: { background: hex } }),
        h('div', { class: 'swatch-meta' },
          d.name ? h('div', { class: 'swatch-name' }, d.name) : null,
          h('button', { class: 'swatch-hex', 'data-interactive': '', 'data-action': 'copy-hex', title: 'Copy colour code' }, hex.toUpperCase()),
          h('div', { class: 'swatch-rgb' }, hexToRgbText(hex)),
        ),
      ];
    }
    case 'comment': {
      const entries = d.entries || [];
      const shown = entries.slice(-3);
      return [
        h('div', { class: 'comment-list' },
          entries.length > 3 ? h('div', { class: 'comment-more' }, `${entries.length - 3} earlier`) : null,
          ...shown.map(e => h('div', { class: 'comment-entry' }, h('div', { class: 'comment-text' }, e.text), h('div', { class: 'comment-time' }, formatDate(e.at)))),
          !entries.length ? h('div', { class: 'empty-hint' }, 'Double-tap to comment') : null,
        ),
      ];
    }
    case 'file': return renderFile(card);
    case 'audio': {
      const audio = h('audio', { controls: true, preload: 'metadata', 'data-interactive': '' });
      blobUrl(d.blobId).then(u => { if (u) audio.src = u; });
      return [
        h('div', { class: 'audio-head' }, h('span', { class: 'audio-ic', html: icon('mic') }), h('span', { class: 'audio-name' }, d.name || 'Voice note')),
        audio,
      ];
    }
    case 'board': return renderBoardTile(card);
    case 'column': return []; // built by the canvas, which owns the child cards
    default: return [h('div', {}, card.type)];
  }
}

function hexToRgbText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return `RGB ${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function renderTodo(card, editing) {
  const d = card.data || {};
  const items = d.items || [];
  const done = items.filter(i => i.done).length;
  const out = [];
  const title = h('div', { class: 'todo-title', 'data-placeholder': editing ? 'List title (optional)' : '' });
  title.textContent = d.title || '';
  if (editing) title.contentEditable = 'plaintext-only';
  if (editing || d.title) out.push(title);
  const list = h('div', { class: 'todo-list' });
  for (const it of items) list.append(todoItemEl(it, editing));
  out.push(list);
  if (editing) out.push(h('button', { class: 'todo-add', 'data-interactive': '', 'data-action': 'add-todo' }, h('span', { html: icon('plus') }), 'Add item'));
  else if (!items.length) out.push(h('div', { class: 'empty-hint' }, 'Double-tap to add items'));
  if (items.length) out.push(h('div', { class: 'todo-progress' },
    h('div', { class: 'todo-bar' }, h('span', { style: { width: `${(done / items.length) * 100}%` } })),
    h('span', {}, `${done}/${items.length}`)));
  return out;
}

export function todoItemEl(it, editing) {
  const text = h('span', { class: 'todo-text', 'data-placeholder': 'To-do' });
  text.textContent = it.text || '';
  if (editing) text.contentEditable = 'plaintext-only';
  return h('div', { class: `todo-item ${it.done ? 'done' : ''}`, 'data-item': it.id },
    h('button', { class: 'todo-check', 'data-interactive': '', 'data-action': 'toggle-todo', 'aria-label': it.done ? 'Mark not done' : 'Mark done', html: it.done ? icon('check') : '' }),
    text,
  );
}

export function setTodoDone(itemEl, done) {
  itemEl.classList.toggle('done', done);
  const b = itemEl.querySelector('.todo-check');
  b.innerHTML = done ? icon('check') : '';
  b.setAttribute('aria-label', done ? 'Mark not done' : 'Mark done');
}

function renderLink(card) {
  const d = card.data || {};
  const out = [];
  const yt = youtubeId(d.url || '');
  if (d.thumbId) {
    const wrap = h('div', { class: 'img-wrap link-thumb' });
    const img = h('img', { alt: '', draggable: 'false' });
    setImg(img, d.thumbId);
    wrap.append(img);
    out.push(wrap);
  } else if (yt && d.showPreview !== false) {
    const wrap = h('div', { class: 'img-wrap link-thumb yt' });
    const img = h('img', { alt: '', draggable: 'false', referrerpolicy: 'no-referrer', loading: 'lazy' });
    img.src = `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`;
    img.onerror = () => wrap.remove();
    wrap.append(img, h('span', { class: 'yt-play', html: icon('play') }));
    out.push(wrap);
  }
  out.push(h('div', { class: 'link-body' },
    h('div', { class: 'link-title' }, d.title || hostOf(d.url || '') || 'Untitled link'),
    d.description ? h('div', { class: 'link-desc' }, d.description) : null,
    h('a', { class: 'link-host', href: d.url || '#', target: '_blank', rel: 'noopener', 'data-interactive': '' },
      h('span', { html: icon('link') }), hostOf(d.url || '') || 'Add a web address'),
  ));
  return out;
}

function renderFile(card) {
  const d = card.data || {};
  const type = d.mime || '';
  const out = [];
  if (type.startsWith('video/')) {
    const v = h('video', { controls: true, preload: 'metadata', playsinline: true, 'data-interactive': '' });
    blobUrl(d.blobId).then(u => { if (u) v.src = u; });
    out.push(v);
  } else if (type.startsWith('audio/')) {
    const a = h('audio', { controls: true, preload: 'metadata', 'data-interactive': '' });
    blobUrl(d.blobId).then(u => { if (u) a.src = u; });
    out.push(a);
  }
  const ext = (d.name || '').split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE';
  out.push(h('div', { class: 'file-row' },
    h('div', { class: 'file-badge' }, ext),
    h('div', { class: 'file-info' }, h('div', { class: 'file-name' }, d.name || 'File'), h('div', { class: 'file-size' }, formatBytes(d.size))),
    h('button', { class: 'icon-btn file-open', 'data-interactive': '', 'data-action': 'open-file', 'aria-label': 'Open file', html: icon('open') }),
  ));
  return out;
}

function renderBoardTile(card) {
  const d = card.data || {};
  const b = state.boards.get(d.boardId);
  const cover = h('div', { class: 'board-cover' });
  const meta = h('div', { class: 'board-meta' });
  const tile = [cover, h('div', { class: 'board-name' }, b?.name || 'Board'), meta];
  fillBoardCover(d.boardId, cover, meta);
  return tile;
}

// Cover: chosen cover image, or a small mosaic of the board's first images.
export async function fillBoardCover(boardId, cover, meta) {
  const b = state.boards.get(boardId);
  const cards = await db.getByIndex('cards', 'boardId', boardId);
  const visible = cards.filter(c => c.type !== 'line');
  if (meta) meta.textContent = visible.length === 1 ? '1 card' : `${visible.length} cards`;
  let ids = [];
  if (b?.coverId) ids = [b.coverId];
  else ids = cards.filter(c => (c.type === 'image' || c.type === 'sketch') && c.data.blobId).sort((a, c) => a.created - c.created).slice(0, 4).map(c => c.data.blobId);
  const swatches = cards.filter(c => c.type === 'swatch').slice(0, 5).map(c => c.data.hex);
  cover.innerHTML = '';
  cover.dataset.n = String(ids.length);
  if (b?.color) cover.dataset.color = b.color;
  if (!ids.length) {
    if (swatches.length) {
      cover.classList.add('cover-swatches');
      for (const hex of swatches) cover.append(h('span', { style: { background: hex } }));
    } else {
      cover.innerHTML = icon('board', 'cover-ic');
    }
    return;
  }
  for (const id of ids) {
    const img = h('img', { alt: '', draggable: 'false' });
    setImg(img, id);
    cover.append(img);
  }
}

export function cardSearchText(card) {
  const d = card.data || {};
  const tmp = document.createElement('div');
  switch (card.type) {
    case 'note': tmp.innerHTML = sanitizeHtml(d.html || ''); return tmp.textContent;
    case 'heading': return d.text || '';
    case 'todo': return [d.title, ...(d.items || []).map(i => i.text)].join(' ');
    case 'link': return [d.title, d.description, d.url].join(' ');
    case 'image': return [d.caption, d.source].join(' ');
    case 'swatch': return [d.name, d.hex].join(' ');
    case 'comment': return (d.entries || []).map(e => e.text).join(' ');
    case 'file': case 'audio': return d.name || '';
    case 'column': return d.title || '';
    case 'line': return d.label || '';
    default: return '';
  }
}

export { esc };
