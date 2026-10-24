import { h, $, $$, clamp, debounce, processImage, isUrl, normaliseUrl, hostOf, sanitizeHtml, vibrate } from './util.js';
import { icon } from './icons.js';
import * as db from './db.js';
import {
  state, subscribe, commit, undo, redo, upd, cardUpdate, cardDataUpdate, newCard, newBoard, maxZ,
  deleteBoardChanges, cloneSubtreeChanges, saveBlob, duplicateBlob, blobUrl, boardPath, openBoard, closeBoard, releaseUrls,
} from './store.js';
import { renderCardContent, todoItemEl, setTodoDone, TYPE_LABEL, CARD_COLORS } from './cards.js';
import { sheet, menu, toast, confirmDialog, promptDialog, pickFiles, backGuard } from './ui.js';
import {
  editLink, editSwatch, editImageDetails, editComments, pickColor, pickBoard, viewImage, sketchPad, recordVoice,
} from './editors.js';
import { exportFlow } from './backup-ui.js';

const GRID = 12;
const MIN_S = 0.12, MAX_S = 3;
const TAP_SLOP = 8;

export const ADD_TYPES = [
  { type: 'note', label: 'Note', icon: 'note' },
  { type: 'image', label: 'Image', icon: 'image' },
  { type: 'camera', label: 'Camera', icon: 'camera' },
  { type: 'todo', label: 'To-do', icon: 'todo' },
  { type: 'link', label: 'Link', icon: 'link' },
  { type: 'column', label: 'Column', icon: 'column' },
  { type: 'board', label: 'Board', icon: 'board' },
  { type: 'heading', label: 'Heading', icon: 'heading' },
  { type: 'swatch', label: 'Colour', icon: 'swatch' },
  { type: 'sketch', label: 'Sketch', icon: 'sketch' },
  { type: 'line', label: 'Line', icon: 'line' },
  { type: 'comment', label: 'Comment', icon: 'comment' },
  { type: 'file', label: 'File', icon: 'file' },
  { type: 'audio', label: 'Voice note', icon: 'mic' },
  { type: 'paste', label: 'Paste', icon: 'paste' },
];

export async function mountBoard(root, boardId, { onNavigate }) {
  await openBoard(boardId);
  const board = () => state.boards.get(boardId);
  const settings = await db.getSettings();

  // ---------- DOM ----------
  const crumbs = h('div', { class: 'crumbs' });
  const undoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Undo', html: icon('undo'), onclick: doUndo });
  const redoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Redo', html: icon('redo'), onclick: doRedo });
  const topbar = h('header', { class: 'topbar board-top' },
    h('button', { class: 'icon-btn', 'aria-label': 'Back', html: icon('back'), onclick: goUp }),
    crumbs,
    undoBtn, redoBtn,
    h('button', { class: 'icon-btn', 'aria-label': 'Board options', html: icon('more'), onclick: boardMenu }),
  );
  const linesSvg = svgEl('svg', { class: 'lines-layer' });
  const linesG = svgEl('g');
  linesSvg.append(linesG);
  const handleSvg = svgEl('svg', { class: 'handle-layer' });
  const handleG = svgEl('g');
  handleSvg.append(handleG);
  const world = h('div', { class: 'world' }, linesSvg, handleSvg);
  const viewport = h('div', { class: 'viewport', tabindex: '0' }, world);
  const emptyHint = h('div', { class: 'board-empty' },
    h('p', {}, 'This board is empty.'),
    h('p', { class: 'muted' }, 'Tap + to add notes, images, links and more. Double-tap the board to drop a note; press and hold to choose what to add there.'),
  );
  const ctxBar = h('div', { class: 'ctx-bar', hidden: true });
  const formatBar = h('div', { class: 'format-bar', hidden: true });
  const zoomLabel = h('button', { class: 'zoom-label', 'aria-label': 'Reset zoom to 100%', onclick: () => zoomTo(1) }, '100%');
  const dock = h('div', { class: 'dock' },
    h('button', { class: 'icon-btn dock-btn', 'aria-label': 'Fit everything on screen', html: icon('fit'), onclick: () => fitAll(true) }),
    h('button', { class: 'add-btn', 'aria-label': 'Add to board', html: icon('plus'), onclick: () => addMenu() }),
    zoomLabel,
  );
  const modeBanner = h('div', { class: 'mode-banner', hidden: true });
  const view = h('div', { class: 'board-view' }, topbar, viewport, emptyHint, modeBanner, ctxBar, formatBar, dock);
  root.append(view);

  // ---------- state ----------
  const els = new Map();
  let vx = 40, vy = 90, vs = 1;
  let selectedId = null;
  let editingId = null, editGuard = null, editOriginal = null;
  let connectFrom = null;
  let place = null;           // where the next added card goes (world coords), from long-press / double-tap
  const ro = new ResizeObserver(() => scheduleLines());

  // ---------- helpers ----------
  function svgEl(tag, attrs = {}) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }
  const vpRect = () => viewport.getBoundingClientRect();
  function toWorld(cx, cy) {
    const r = vpRect();
    return { x: (cx - r.left - vx) / vs, y: (cy - r.top - vy) / vs };
  }
  function worldRect(el) {
    const r = el.getBoundingClientRect(), v = vpRect();
    return { x: (r.left - v.left - vx) / vs, y: (r.top - v.top - vy) / vs, w: r.width / vs, h: r.height / vs };
  }
  const snap = v => (settings.snap ? Math.round(v / GRID) * GRID : Math.round(v));
  const cardOf = id => state.cards.get(id);

  function applyView() {
    world.style.transform = `translate(${vx}px, ${vy}px) scale(${vs})`;
    const gs = GRID * 2 * vs;
    viewport.style.setProperty('--gs', `${gs}px`);
    viewport.style.setProperty('--gx', `${vx}px`);
    viewport.style.setProperty('--gy', `${vy}px`);
    viewport.classList.toggle('zoomed-out', vs < 0.45);
    zoomLabel.textContent = `${Math.round(vs * 100)}%`;
    saveView();
  }
  const saveView = debounce(() => {
    const b = state.boards.get(boardId);
    if (!b) return;
    const nb = { ...b, view: { x: vx, y: vy, s: vs } };
    state.boards.set(boardId, nb);
    db.put('boards', nb);
  }, 500);

  function zoomAt(cx, cy, ns) {
    ns = clamp(ns, MIN_S, MAX_S);
    const r = vpRect();
    const px = cx - r.left, py = cy - r.top;
    const wx = (px - vx) / vs, wy = (py - vy) / vs;
    vs = ns; vx = px - wx * vs; vy = py - wy * vs;
    applyView();
  }
  function zoomTo(ns) {
    const r = vpRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, ns);
  }

  function fitAll(animate) {
    const free = [...state.cards.values()].filter(c => !c.columnId && c.type !== 'line');
    if (!free.length && ![...state.cards.values()].some(c => c.type === 'line')) { vs = 1; vx = 40; vy = 90; applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of free) {
      const el = els.get(c.id);
      if (!el) continue;
      const r = { x: c.x, y: c.y, w: el.offsetWidth, h: el.offsetHeight };
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    // Loose line ends count too.
    for (const l of state.cards.values()) {
      if (l.type !== 'line') continue;
      for (const end of [l.data.from, l.data.to]) {
        if (end && !end.id) { x0 = Math.min(x0, end.x); y0 = Math.min(y0, end.y); x1 = Math.max(x1, end.x); y1 = Math.max(y1, end.y); }
      }
    }
    if (!isFinite(x0) || !isFinite(y0)) { vs = 1; vx = 40; vy = 90; applyView(); return; }
    x1 = Math.max(x1, x0 + 1); y1 = Math.max(y1, y0 + 1);
    const r = vpRect();
    const pad = 32, top = 70, bottom = 110;
    const s = clamp(Math.min((r.width - pad * 2) / (x1 - x0), (r.height - top - bottom) / (y1 - y0)), MIN_S, 1.2);
    vs = s;
    vx = (r.width - (x1 - x0) * s) / 2 - x0 * s;
    vy = top + (r.height - top - bottom - (y1 - y0) * s) / 2 - y0 * s;
    if (animate) { world.classList.add('animating'); setTimeout(() => world.classList.remove('animating'), 260); }
    applyView();
  }

  function centerOn(id) {
    const el = els.get(id);
    if (!el) return;
    const wr = worldRect(el), r = vpRect();
    if (vs < 0.6) vs = 0.9;
    vx = r.width / 2 - (wr.x + wr.w / 2) * vs;
    vy = r.height / 2.4 - (wr.y + wr.h / 2) * vs;
    world.classList.add('animating'); setTimeout(() => world.classList.remove('animating'), 260);
    applyView();
  }

  function viewportCenterWorld() {
    const r = vpRect();
    return toWorld(r.left + r.width / 2, r.top + r.height * 0.42);
  }
  const EST_H = { note: 110, heading: 50, todo: 150, link: 220, column: 170, board: 200, swatch: 190, sketch: 200, comment: 110, file: 80, audio: 120, image: 220 };
  function occupied() {
    const out = [];
    for (const c of state.cards.values()) {
      if (c.columnId || c.type === 'line') continue;
      const el = els.get(c.id);
      out.push({ x: c.x, y: c.y, w: el ? el.offsetWidth : c.w, h: el ? el.offsetHeight : 150 });
    }
    return out;
  }
  // Find an empty patch near the middle of the screen so new cards don't pile up.
  function freeSpot(w, hgt, extra = []) {
    const rects = [...occupied(), ...extra];
    const r = vpRect();
    const c = toWorld(r.left + r.width / 2, r.top + r.height * 0.42);
    const gap = 20, step = 36;
    const fits = (x, y) => !rects.some(o => x < o.x + o.w + gap && x + w + gap > o.x && y < o.y + o.h + gap && y + hgt + gap > o.y);
    const x0 = c.x - w / 2, y0 = c.y - hgt / 2;
    for (let ring = 0; ring < 40; ring++) {
      const pts = [];
      for (let i = -ring; i <= ring; i++) {
        pts.push([i, -ring], [i, ring]);
        if (Math.abs(i) !== ring) pts.push([-ring, i], [ring, i]);
      }
      pts.sort((a, b) => Math.hypot(a[0], a[1] * 1.3) - Math.hypot(b[0], b[1] * 1.3));
      for (const [i, j] of pts) {
        const x = snap(x0 + i * step), y = snap(y0 + j * step);
        if (fits(x, y)) return { x, y };
      }
    }
    return { x: snap(x0), y: snap(y0) };
  }
  function nextPlace(w = 240, type = 'note', hgt) {
    if (place) {
      const p = place; place = null;
      return { x: snap(p.x), y: snap(p.y) };
    }
    return freeSpot(w, hgt || EST_H[type] || 150);
  }

  // ---------- rendering ----------
  function renderTitle() {
    const path = boardPath(boardId);
    crumbs.innerHTML = '';
    path.forEach((b, i) => {
      const last = i === path.length - 1;
      if (i) crumbs.append(h('span', { class: 'crumb-sep' }, '/'));
      crumbs.append(h('button', {
        class: `crumb ${last ? 'current' : ''}`,
        onclick: () => (last ? renameBoard() : onNavigate({ board: b.id })),
      }, b.name || 'Untitled board'));
    });
    if (path.length > 2) crumbs.classList.add('long'); else crumbs.classList.remove('long');
    requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    viewport.dataset.bg = board()?.bg || 'dots';
  }

  function cardClasses(c) {
    return ['card', `card-${c.type}`, c.color ? `color-${c.color}` : '', c.locked ? 'locked' : '',
      c.id === selectedId ? 'selected' : '', c.id === editingId ? 'editing' : '', c.columnId ? 'in-column' : '',
      c.type === 'column' && c.data.collapsed ? 'collapsed' : ''].filter(Boolean).join(' ');
  }

  function renderCard(c, force = false) {
    if (c.type === 'line') return;
    let el = els.get(c.id);
    const isNew = !el;
    if (isNew) {
      el = h('div', { 'data-id': c.id });
      els.set(c.id, el);
      ro.observe(el);
    }
    el.className = cardClasses(c);
    if (c.columnId && state.cards.get(c.columnId)) {
      el.style.left = el.style.top = el.style.zIndex = '';
      el.style.width = '';
    } else {
      el.style.left = `${c.x}px`; el.style.top = `${c.y}px`; el.style.width = `${c.w}px`;
      el.style.zIndex = String(c.z || 1);
      if (el.parentNode !== world) world.append(el);
    }
    if (c.id === editingId && !force) return el;
    if (c.type === 'column') renderColumn(c, el);
    else {
      el.replaceChildren(...renderCardContent(c, { editing: c.id === editingId }));
      if (c.id === selectedId && !c.locked && !c.columnId) el.append(h('div', { class: 'resize-h', 'aria-hidden': 'true' }));
      if (c.locked) el.append(h('span', { class: 'lock-badge', html: icon('lock') }));
    }
    return el;
  }

  function renderColumn(c, el) {
    const d = c.data;
    const items = (d.items || []).map(id => state.cards.get(id)).filter(x => x && x.columnId === c.id);
    // Include strays that think they belong here but aren't listed.
    for (const x of state.cards.values()) if (x.columnId === c.id && !items.includes(x)) items.push(x);
    const head = h('div', { class: 'col-head' },
      h('div', { class: 'col-title', 'data-placeholder': 'Column' }, d.title || ''),
      h('span', { class: 'col-count' }, String(items.length)),
      h('button', { class: 'icon-btn col-toggle', 'data-interactive': '', 'data-action': 'toggle-column', 'aria-label': d.collapsed ? 'Expand column' : 'Collapse column', html: icon(d.collapsed ? 'expand' : 'collapse') }),
    );
    const body = h('div', { class: 'col-items' });
    const keep = new Set();
    for (const it of items) {
      const child = renderCard(it, it.id !== editingId);
      body.append(child);
      keep.add(it.id);
    }
    if (!items.length) body.append(h('div', { class: 'col-empty' }, 'Drag cards here'));
    el.replaceChildren(head, body);
    if (c.id === selectedId && !c.locked) el.append(h('div', { class: 'resize-h', 'aria-hidden': 'true' }));
    if (c.locked) el.append(h('span', { class: 'lock-badge', html: icon('lock') }));
  }

  function removeEl(id) {
    const el = els.get(id);
    if (el) { ro.unobserve(el); el.remove(); els.delete(id); }
  }

  function renderAll() {
    for (const id of [...els.keys()]) removeEl(id);
    const cards = [...state.cards.values()];
    // Columns before their children so children land in them.
    for (const c of cards.filter(c => !c.columnId)) renderCard(c, true);
    for (const c of cards.filter(c => c.columnId && !state.cards.get(c.columnId))) renderCard({ ...c, columnId: null }, true);
    updateEmpty();
    scheduleLines();
  }

  function updateEmpty() {
    emptyHint.hidden = state.cards.size > 0;
  }

  // ---------- lines ----------
  let linesRaf = 0;
  function scheduleLines() {
    if (linesRaf) return;
    linesRaf = requestAnimationFrame(() => { linesRaf = 0; drawLines(); });
  }

  const liveRects = new Map(); // card id -> world rect override while dragging
  function rectOf(id) {
    if (liveRects.has(id)) return liveRects.get(id);
    const c = cardOf(id), el = els.get(id);
    if (!c || !el || !el.isConnected) return null;
    if (c.columnId) {
      const col = els.get(c.columnId);
      // Inside a collapsed column: lines point at the column instead.
      if (!el.offsetWidth && col) return worldRect(col);
      return worldRect(el);
    }
    return { x: c.x, y: c.y, w: el.offsetWidth, h: el.offsetHeight };
  }

  function endpoint(end) {
    if (end?.id) {
      const r = rectOf(end.id);
      if (r) return { x: r.x + r.w / 2, y: r.y + r.h / 2, rect: r };
    }
    return { x: end?.x || 0, y: end?.y || 0, rect: null };
  }

  function clipToRect(c, toward, rect) {
    if (!rect) return { x: c.x, y: c.y };
    const dx = toward.x - c.x, dy = toward.y - c.y;
    if (!dx && !dy) return { x: c.x, y: c.y };
    const tx = dx ? (rect.w / 2) / Math.abs(dx) : Infinity;
    const ty = dy ? (rect.h / 2) / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty, 1);
    const len = Math.hypot(dx, dy);
    const gap = 6 / len;
    return { x: c.x + dx * (t + gap), y: c.y + dy * (t + gap) };
  }

  function lineGeometry(c) {
    const d = c.data;
    const A = endpoint(d.from), B = endpoint(d.to);
    let ctrl = null;
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    if (d.curve === 'curved') {
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
      const k = 0.22 * (d.bend || 1);
      ctrl = { x: mid.x - dy / len * len * k, y: mid.y + dx / len * len * k };
    }
    const a = clipToRect(A, ctrl || B, A.rect);
    const b = clipToRect(B, ctrl || A, B.rect);
    let path, labelPt;
    if (ctrl) {
      path = `M${a.x},${a.y} Q${ctrl.x},${ctrl.y} ${b.x},${b.y}`;
      labelPt = { x: 0.25 * a.x + 0.5 * ctrl.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * ctrl.y + 0.25 * b.y };
    } else {
      path = `M${a.x},${a.y} L${b.x},${b.y}`;
      labelPt = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    return { a, b, ctrl, path, labelPt };
  }

  function arrowHead(tip, from, w) {
    const dx = tip.x - from.x, dy = tip.y - from.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const L = 9 + w * 2.2, W = 5 + w * 1.3;
    return `${tip.x},${tip.y} ${tip.x - ux * L - uy * W},${tip.y - uy * L + ux * W} ${tip.x - ux * L + uy * W},${tip.y - uy * L - ux * W}`;
  }

  function drawLines() {
    linesG.innerHTML = '';
    handleG.innerHTML = '';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
    const items = [];
    for (const c of state.cards.values()) {
      if (c.type !== 'line') continue;
      const g = lineGeometry(c);
      grow(g.a); grow(g.b); if (g.ctrl) grow(g.ctrl);
      items.push({ c, g });
    }
    if (!items.length) { linesSvg.style.display = 'none'; handleSvg.style.display = 'none'; return; }
    linesSvg.style.display = ''; handleSvg.style.display = '';
    const pad = 60;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    for (const svg of [linesSvg, handleSvg]) {
      svg.style.left = `${x0}px`; svg.style.top = `${y0}px`;
      svg.setAttribute('width', x1 - x0); svg.setAttribute('height', y1 - y0);
    }
    linesG.setAttribute('transform', `translate(${-x0},${-y0})`);
    handleG.setAttribute('transform', `translate(${-x0},${-y0})`);
    for (const { c, g } of items) {
      const d = c.data;
      const w = d.weight || 2;
      const grp = svgEl('g', { 'data-line': c.id, class: `line ${c.color ? 'color-' + c.color : ''} ${c.id === selectedId ? 'selected' : ''}` });
      grp.append(svgEl('path', { d: g.path, class: 'line-hit' }));
      grp.append(svgEl('path', { d: g.path, class: 'line-vis', 'stroke-width': w, 'stroke-dasharray': d.style === 'dashed' ? `${w * 4} ${w * 3}` : d.style === 'dotted' ? `0.1 ${w * 3}` : '' }));
      if (d.endArrow !== false) grp.append(svgEl('polygon', { class: 'line-head', points: arrowHead(g.b, g.ctrl || g.a, w) }));
      if (d.startArrow) grp.append(svgEl('polygon', { class: 'line-head', points: arrowHead(g.a, g.ctrl || g.b, w) }));
      if (d.label) {
        const t = svgEl('text', { x: g.labelPt.x, y: g.labelPt.y, class: 'line-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        t.textContent = d.label;
        grp.append(t);
      }
      linesG.append(grp);
      if (c.id === selectedId) {
        for (const [end, p] of [['from', g.a], ['to', g.b]]) {
          handleG.append(svgEl('circle', { cx: p.x, cy: p.y, r: 13 / Math.max(vs, 0.5), class: 'line-handle', 'data-handle': end, 'data-line-id': c.id }));
        }
      }
    }
    // Labels get a halo so they read over the line.
    for (const t of $$('text.line-label', linesG)) t.setAttribute('paint-order', 'stroke');
  }

  // ---------- selection & context bar ----------
  function select(id) {
    if (editingId && editingId !== id) stopEdit();
    const prev = selectedId;
    selectedId = id;
    for (const pid of [prev, id]) {
      if (!pid) continue;
      const c = cardOf(pid);
      if (!c) continue;
      if (c.type === 'line') scheduleLines();
      else {
        renderCard(c, true);
        if (c.columnId && state.cards.get(c.columnId)) renderCard(state.cards.get(c.columnId), true);
      }
    }
    renderCtx();
  }

  function ctxBtn(ic, label, fn, extra = '') {
    return h('button', { class: `ctx-btn ${extra}`, onclick: fn }, h('span', { html: icon(ic) }), h('span', { class: 'ctx-label' }, label));
  }

  function renderCtx() {
    const c = selectedId && cardOf(selectedId);
    if (!c || editingId) { ctxBar.hidden = true; dock.hidden = !!editingId; return; }
    dock.hidden = true;
    ctxBar.hidden = false;
    ctxBar.innerHTML = '';
    if (c.type === 'line') {
      ctxBar.append(
        ctxBtn('line', 'Arrows', () => lineArrows(c)),
        ctxBtn('sketch', 'Style', () => lineStyle(c)),
        ctxBtn('palette', 'Colour', () => colorCard(c)),
        ctxBtn('text', 'Label', () => lineLabel(c)),
        ctxBtn('trash', 'Delete', () => deleteCard(c), 'danger'),
      );
      return;
    }
    const editLabel = { board: 'Open', image: 'View', file: 'Open', audio: 'Rename' }[c.type] || 'Edit';
    const editIcon = { board: 'open', image: 'zoomin', file: 'open' }[c.type] || 'edit';
    ctxBar.append(
      ctxBtn(editIcon, editLabel, () => activate(c)),
      ctxBtn('palette', 'Colour', () => colorCard(c)),
      ctxBtn('connect', 'Connect', () => startConnect(c)),
      ctxBtn('copy', 'Duplicate', () => duplicateCard(c)),
      ctxBtn('more', 'More', () => moreMenu(c)),
      ctxBtn('trash', 'Delete', () => deleteCard(c), 'danger'),
    );
  }

  // ---------- activation (second tap / Edit button) ----------
  async function activate(c) {
    switch (c.type) {
      case 'note': case 'heading': case 'todo': startEdit(c.id); break;
      case 'board': onNavigate({ board: c.data.boardId }); break;
      case 'image': viewImage(c.data.blobId, c.data.caption); break;
      case 'link': {
        const r = await editLink(c.data);
        if (r) await commit([cardDataUpdate(cardOf(c.id), r)], { label: 'Edit link' });
        break;
      }
      case 'swatch': {
        const r = await editSwatch(c.data);
        if (r) await commit([cardDataUpdate(cardOf(c.id), r)], { label: 'Edit colour' });
        break;
      }
      case 'sketch': {
        const r = await sketchPad(c.data.blobId);
        if (r) await commit([cardDataUpdate(cardOf(c.id), r)], { label: 'Edit sketch' });
        break;
      }
      case 'comment': {
        const r = await editComments(c.data.entries || []);
        if (r) await commit([cardDataUpdate(cardOf(c.id), { entries: r })], { label: 'Edit comments' });
        break;
      }
      case 'column': {
        const t = await promptDialog('Column title', c.data.title || '', { placeholder: 'Column' });
        if (t != null) await commit([cardDataUpdate(cardOf(c.id), { title: t.trim() })], { label: 'Rename column' });
        break;
      }
      case 'file': openFile(c); break;
      case 'audio': {
        const t = await promptDialog('Rename voice note', c.data.name || '');
        if (t != null && t.trim()) await commit([cardDataUpdate(cardOf(c.id), { name: t.trim() })]);
        break;
      }
      case 'line': lineLabel(c); break;
    }
  }

  async function openFile(c) {
    const blob = await db.getBlob(c.data.blobId);
    if (!blob) { toast('This file is missing from storage'); return; }
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) {
      const a = h('a', { href: url, download: c.data.name || 'file' });
      document.body.append(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }

  // ---------- inline editing ----------
  function startEdit(id) {
    if (editingId) stopEdit();
    const c = cardOf(id);
    if (!c) return;
    editingId = id;
    editOriginal = structuredClone(c);
    if (selectedId !== id) { const prev = selectedId; selectedId = id; if (prev && cardOf(prev)) renderCard(cardOf(prev), true); }
    const el = renderCard(c, true);
    el.classList.add('editing');
    renderCtx();
    showFormatBar(c.type);
    editGuard = backGuard(() => { editGuard = null; stopEdit(); });
    const target = c.type === 'note' ? $('.note-body', el)
      : c.type === 'heading' ? $('.heading-text', el)
      : ($$('.todo-text', el).find(t => !t.textContent) || $$('.todo-text', el).pop() || $('.todo-title', el));
    if (c.type === 'todo' && !(c.data.items || []).length) { addTodoItem(el); }
    else focusEnd(target);
    setTimeout(() => ensureVisible(el), 350);
  }

  function focusEnd(node) {
    if (!node) return;
    node.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges(); s.addRange(r);
  }

  function readEdit(c, el) {
    if (c.type === 'note') return { html: sanitizeHtml($('.note-body', el)?.innerHTML || '') };
    if (c.type === 'heading') return { text: ($('.heading-text', el)?.textContent || '').trim() };
    if (c.type === 'todo') {
      const title = ($('.todo-title', el)?.textContent || '').trim();
      const items = $$('.todo-item', el).map(it => ({
        id: it.dataset.item, text: $('.todo-text', it).textContent.trim(), done: it.classList.contains('done'),
      })).filter(i => i.text);
      return { title, items };
    }
    return {};
  }

  const autosave = debounce(() => {
    if (!editingId) return;
    const c = cardOf(editingId), el = els.get(editingId);
    if (!c || !el) return;
    const next = { ...c, data: { ...c.data, ...readEdit(c, el) }, updated: Date.now() };
    state.cards.set(c.id, next);
    db.put('cards', next);
  }, 1200);

  function stopEdit() {
    if (!editingId) return;
    const id = editingId;
    const c = cardOf(id), el = els.get(id);
    editingId = null;
    if (editGuard) { const g = editGuard; editGuard = null; g.close(); }
    hideFormatBar();
    if (document.activeElement && el?.contains(document.activeElement)) document.activeElement.blur();
    if (c && el) {
      const data = { ...c.data, ...readEdit(c, el) };
      const before = editOriginal;
      const after = { ...c, data, updated: Date.now() };
      const isEmpty = (c.type === 'note' && !el.querySelector('.note-body')?.textContent.trim() && !/<img/i.test(data.html))
        || (c.type === 'heading' && !data.text) || (c.type === 'todo' && !data.items.length && !data.title);
      if (isEmpty && before && !hasContent(before)) {
        // An empty card that was never filled in: remove it quietly.
        commit([upd('cards', before, null)], { record: false }).then(() => db.del('cards', id));
        state.undo = state.undo.filter(op => !op.changes.some(ch => ch.id === id && !ch.before));
      } else if (JSON.stringify(before?.data) !== JSON.stringify(data)) {
        commit([upd('cards', before, after)], { label: 'Edit' });
      } else {
        renderCard(c, true);
        if (c.columnId && state.cards.get(c.columnId)) renderCard(state.cards.get(c.columnId), true);
      }
    }
    editOriginal = null;
    // Finished editing: clear the selection so the + button is back.
    if (selectedId === id) {
      selectedId = null;
      const cc = cardOf(id);
      if (cc) { renderCard(cc, true); if (cc.columnId && cardOf(cc.columnId)) renderCard(cardOf(cc.columnId), true); }
    }
    renderCtx();
  }

  function hasContent(c) {
    const d = c.data || {};
    if (c.type === 'note') return !!(d.html && d.html.replace(/<[^>]+>/g, '').trim());
    if (c.type === 'heading') return !!d.text;
    if (c.type === 'todo') return !!((d.items || []).length || d.title);
    return true;
  }

  function showFormatBar(type) {
    formatBar.innerHTML = '';
    const fbtn = (ic, label, fn) => {
      const b = h('button', { class: 'fmt-btn', 'aria-label': label, html: icon(ic) });
      b.addEventListener('pointerdown', e => { e.preventDefault(); fn(); });
      b.addEventListener('mousedown', e => e.preventDefault());
      return b;
    };
    const exec = (cmd, arg) => () => { document.execCommand(cmd, false, arg); autosave(); };
    if (type === 'note') {
      formatBar.append(
        fbtn('bold', 'Bold', exec('bold')),
        fbtn('italic', 'Italic', exec('italic')),
        fbtn('strike', 'Strikethrough', exec('strikeThrough')),
        fbtn('h1', 'Heading', () => {
          const block = document.queryCommandValue('formatBlock');
          document.execCommand('formatBlock', false, /h1/i.test(block) ? 'div' : 'h1'); autosave();
        }),
        fbtn('ul', 'Bulleted list', exec('insertUnorderedList')),
        fbtn('ol', 'Numbered list', exec('insertOrderedList')),
        fbtn('quote', 'Quote', () => {
          const block = document.queryCommandValue('formatBlock');
          document.execCommand('formatBlock', false, /blockquote/i.test(block) ? 'div' : 'blockquote'); autosave();
        }),
      );
    } else if (type === 'todo') {
      formatBar.append(fbtn('plus', 'Add item', () => addTodoItem(els.get(editingId))));
    }
    formatBar.append(h('div', { class: 'grow' }));
    const done = h('button', { class: 'btn btn-primary fmt-done' }, 'Done');
    done.addEventListener('pointerdown', e => { e.preventDefault(); stopEdit(); });
    formatBar.append(done);
    formatBar.hidden = false;
    dock.hidden = true;
  }
  function hideFormatBar() { formatBar.hidden = true; formatBar.innerHTML = ''; dock.hidden = !!selectedId; }

  function addTodoItem(el, afterItem = null) {
    if (!el) return;
    const list = $('.todo-list', el);
    const item = todoItemEl({ id: db.uid(), text: '', done: false }, true);
    if (afterItem) afterItem.after(item); else list.append(item);
    focusEnd($('.todo-text', item));
    autosave();
  }

  function ensureVisible(el) {
    if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect(), v = vpRect();
    const vv = window.visualViewport;
    const visibleBottom = vv ? Math.min(v.bottom, vv.height + vv.offsetTop) - 70 : v.bottom - 70;
    const top = v.top + 64;
    let dy = 0;
    if (r.top < top) dy = top - r.top;
    else if (r.top + Math.min(r.height, 160) > visibleBottom) dy = visibleBottom - (r.top + Math.min(r.height, 160));
    let dx = 0;
    if (r.left < v.left + 8) dx = v.left + 8 - r.left;
    else if (r.right > v.right - 8 && r.width < v.width) dx = v.right - 8 - r.right;
    if (dx || dy) { vx += dx; vy += dy; world.classList.add('animating'); setTimeout(() => world.classList.remove('animating'), 260); applyView(); }
  }
  const onVV = () => { if (editingId) ensureVisible(els.get(editingId)); };
  window.visualViewport?.addEventListener('resize', onVV);

  // Keyboard behaviour inside cards being edited.
  world.addEventListener('keydown', e => {
    if (!editingId) return;
    const c = cardOf(editingId), el = els.get(editingId);
    if (!c || !el) return;
    if (c.type === 'heading' && e.key === 'Enter') { e.preventDefault(); stopEdit(); return; }
    if (c.type === 'todo') {
      const t = e.target;
      if (t.classList.contains('todo-title') && e.key === 'Enter') {
        e.preventDefault();
        const first = $('.todo-text', el);
        if (first) focusEnd(first); else addTodoItem(el);
        return;
      }
      if (t.classList.contains('todo-text')) {
        const item = t.closest('.todo-item');
        if (e.key === 'Enter') { e.preventDefault(); addTodoItem(el, item); return; }
        if (e.key === 'Backspace' && !t.textContent) {
          e.preventDefault();
          const prev = item.previousElementSibling;
          item.remove();
          if (prev) focusEnd($('.todo-text', prev)); else { const ti = $('.todo-title', el); if (ti) focusEnd(ti); }
          autosave();
        }
      }
    }
    if (e.key === 'Escape') stopEdit();
  });
  world.addEventListener('input', () => { if (editingId) autosave(); });
  // Paste into notes as plain text so formatting from other apps stays out.
  world.addEventListener('paste', e => {
    if (!editingId) return;
    const text = e.clipboardData?.getData('text/plain');
    if (text != null) { e.preventDefault(); document.execCommand('insertText', false, text); }
  });

  // ---------- pointer interaction ----------
  const pointers = new Map();
  let g = null;          // current gesture
  let lastTap = { t: 0, x: 0, y: 0, target: null };
  let longTimer = null;

  viewport.addEventListener('pointerdown', onDown);
  viewport.addEventListener('pointermove', onMove);
  viewport.addEventListener('pointerup', onUp);
  viewport.addEventListener('pointercancel', onCancel);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('contextmenu', e => { if (!e.target.closest('.editing')) e.preventDefault(); });
  world.addEventListener('click', onClickAction);

  function classify(target) {
    const handle = target.closest('.line-handle');
    if (handle) return { kind: 'handle', lineId: handle.dataset.lineId, end: handle.dataset.handle };
    const resize = target.closest('.resize-h');
    if (resize) return { kind: 'resize', id: resize.closest('.card').dataset.id };
    const line = target.closest('[data-line]');
    if (line) return { kind: 'line', id: line.dataset.line };
    const cardEl = target.closest('.card');
    if (cardEl) {
      const id = cardEl.dataset.id;
      if (id === editingId) return { kind: 'editing', id };
      if (target.closest('[data-interactive]')) return { kind: 'interactive', id };
      return { kind: 'card', id };
    }
    return { kind: 'empty' };
  }

  function onDown(e) {
    if (e.button && e.button !== 0) return;
    const info = classify(e.target);
    if (info.kind === 'editing' || info.kind === 'interactive') return; // let the browser handle it
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { viewport.setPointerCapture(e.pointerId); } catch {}
    clearTimeout(longTimer);
    if (pointers.size === 2) {
      if (g && g.mode === 'drag') endDrag(false);
      const [p1, p2] = [...pointers.values()];
      g = { mode: 'pinch', d0: Math.hypot(p1.x - p2.x, p1.y - p2.y), m0: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, s0: vs, x0: vx, y0: vy };
      return;
    }
    if (pointers.size > 2) return;
    g = { mode: 'pending', info, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, id: e.pointerId, t: Date.now() };
    if (info.kind === 'resize') { const c = cardOf(info.id); g = { ...g, mode: 'resize', w0: c.w }; return; }
    if (info.kind === 'handle') { g = { ...g, mode: 'handle' }; return; }
    if (info.kind === 'empty' || info.kind === 'card') {
      longTimer = setTimeout(() => {
        if (!g || g.mode !== 'pending') return;
        vibrate(15);
        g.mode = 'done';
        if (info.kind === 'empty') {
          const w = toWorld(g.sx, g.sy);
          place = { x: w.x, y: w.y };
          addMenu(true);
        } else {
          select(info.id);
          moreMenu(cardOf(info.id));
        }
      }, 520);
    }
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId) || !g) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.mode === 'pinch') {
      if (pointers.size < 2) return;
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const r = vpRect();
      const ns = clamp(g.s0 * d / g.d0, MIN_S, MAX_S);
      const wx = (g.m0.x - r.left - g.x0) / g.s0, wy = (g.m0.y - r.top - g.y0) / g.s0;
      vs = ns; vx = m.x - r.left - wx * vs; vy = m.y - r.top - wy * vs;
      applyView();
      return;
    }
    if (e.pointerId !== g.id) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (g.mode === 'pending') {
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      clearTimeout(longTimer);
      const c = g.info.kind === 'card' && cardOf(g.info.id);
      if (c && !c.locked && !connectFrom) startDrag(c, e);
      else g.mode = 'pan';
    }
    if (g.mode === 'pan') {
      vx += e.clientX - g.lx; vy += e.clientY - g.ly;
      applyView();
    } else if (g.mode === 'drag') moveDrag(e);
    else if (g.mode === 'resize') {
      const c = cardOf(g.info.id), el = els.get(c.id);
      const min = c.type === 'board' || c.type === 'swatch' ? 110 : 140;
      const w = clamp(Math.round(g.w0 + dx / vs), min, 1400);
      el.style.width = `${w}px`;
      g.newW = w;
      scheduleLines();
    } else if (g.mode === 'handle') moveHandle(e);
    g.lx = e.clientX; g.ly = e.clientY;
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    clearTimeout(longTimer);
    if (!g) return;
    if (g.mode === 'pinch') { if (!pointers.size) g = null; else g = { mode: 'done' }; return; }
    if (e.pointerId !== g.id) return;
    const mode = g.mode;
    if (mode === 'pending') handleTap(g.info, e);
    else if (mode === 'drag') endDrag(true);
    else if (mode === 'resize' && g.newW) {
      const c = cardOf(g.info.id);
      const w = settings.snap ? Math.round(g.newW / GRID) * GRID : g.newW;
      commit([cardUpdate(c, { w })], { label: 'Resize' });
    } else if (mode === 'handle') endHandle(e);
    if (!pointers.size) g = null;
  }

  function onCancel(e) {
    pointers.delete(e.pointerId);
    clearTimeout(longTimer);
    if (g?.mode === 'drag') endDrag(true);
    if (!pointers.size) g = null;
  }

  function onWheel(e) {
    if (e.target.closest('.editing')) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, vs * Math.exp(-e.deltaY * 0.01));
    else { vx -= e.deltaX; vy -= e.deltaY; applyView(); }
  }

  function handleTap(info, e) {
    const now = Date.now();
    const dbl = now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30 && lastTap.target === (info.id || 'empty');
    lastTap = { t: dbl ? 0 : now, x: e.clientX, y: e.clientY, target: info.id || 'empty' };

    if (info.kind === 'empty') {
      if (connectFrom) { endConnect(); return; }
      if (editingId) { stopEdit(); return; }
      if (dbl) {
        const w = toWorld(e.clientX, e.clientY);
        place = { x: w.x - 20, y: w.y - 20 };
        addOfType('note');
        return;
      }
      if (selectedId) select(null);
      return;
    }
    if (info.kind === 'line') {
      if (connectFrom) { endConnect(); return; }
      if (selectedId === info.id) lineLabel(cardOf(info.id));
      else select(info.id);
      return;
    }
    if (info.kind === 'card') {
      const c = cardOf(info.id);
      if (!c) return;
      if (connectFrom) {
        if (connectFrom !== c.id) makeConnection(connectFrom, c.id);
        endConnect();
        return;
      }
      if (selectedId === c.id) activate(c);
      else select(c.id);
    }
  }

  async function onClickAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const cardEl = btn.closest('.card');
    const c = cardEl && cardOf(cardEl.dataset.id);
    if (!c) return;
    const action = btn.dataset.action;
    if (action === 'toggle-todo') {
      const item = btn.closest('.todo-item');
      if (editingId === c.id) { setTodoDone(item, !item.classList.contains('done')); autosave(); return; }
      const items = (c.data.items || []).map(i => (i.id === item.dataset.item ? { ...i, done: !i.done } : i));
      vibrate(8);
      await commit([cardDataUpdate(c, { items })], { label: 'Tick item' });
    } else if (action === 'add-todo') {
      addTodoItem(cardEl);
    } else if (action === 'toggle-column') {
      await commit([cardDataUpdate(c, { collapsed: !c.data.collapsed })]);
      scheduleLines();
    } else if (action === 'copy-hex') {
      try { await navigator.clipboard.writeText(c.data.hex.toUpperCase()); toast(`Copied ${c.data.hex.toUpperCase()}`); } catch { toast(c.data.hex.toUpperCase()); }
    } else if (action === 'open-file') {
      openFile(c);
    }
  }

  // ---------- dragging cards ----------
  let autoPanRaf = 0;
  function startDrag(c, e) {
    if (editingId) stopEdit();
    const el = els.get(c.id);
    let x = c.x, y = c.y;
    const fromColumn = c.columnId && state.cards.get(c.columnId) ? c.columnId : null;
    if (fromColumn) {
      const r = worldRect(el);
      x = r.x; y = r.y;
      el.style.width = `${r.w}px`;
      world.append(el);
      el.classList.remove('in-column');
      // Leave the column showing the gap closed.
    }
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    el.style.zIndex = '100000';
    el.classList.add('dragging');
    const p = toWorld(e.clientX, e.clientY);
    g.mode = 'drag';
    g.card = c; g.el = el; g.fromColumn = fromColumn;
    g.off = { x: p.x - x, y: p.y - y };
    g.pos = { x, y };
    g.drop = null;
    if (selectedId && selectedId !== c.id) select(null);
    ctxBar.hidden = true;
    dock.hidden = true;
    autoPanLoop();
  }

  function moveDrag(e) {
    const p = toWorld(e.clientX, e.clientY);
    g.pos = { x: p.x - g.off.x, y: p.y - g.off.y };
    g.el.style.left = `${g.pos.x}px`; g.el.style.top = `${g.pos.y}px`;
    g.pointer = { cx: e.clientX, cy: e.clientY };
    liveRects.set(g.card.id, { x: g.pos.x, y: g.pos.y, w: g.el.offsetWidth, h: g.el.offsetHeight });
    // Column drop target (columns can't go inside columns).
    let drop = null;
    if (g.card.type !== 'column') {
      for (const col of state.cards.values()) {
        if (col.type !== 'column' || col.id === g.card.id) continue;
        const cel = els.get(col.id);
        if (!cel) continue;
        const r = worldRect(cel);
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y - 10 && p.y <= r.y + r.h + 30) {
          const kids = $$(':scope > .col-items > .card', cel).filter(k => k !== g.el);
          let index = kids.length;
          for (let i = 0; i < kids.length; i++) {
            const kr = worldRect(kids[i]);
            if (p.y < kr.y + kr.h / 2) { index = i; break; }
          }
          drop = { colId: col.id, index, kids };
          break;
        }
      }
    }
    showDropMarker(drop);
    g.drop = drop;
    scheduleLines();
  }

  let marker = null;
  function showDropMarker(drop) {
    $$('.card-column.drop-target', world).forEach(x => x.classList.remove('drop-target'));
    if (!drop) { marker?.remove(); return; }
    const cel = els.get(drop.colId);
    cel.classList.add('drop-target');
    if (!marker) marker = h('div', { class: 'col-marker' });
    const body = $(':scope > .col-items', cel);
    const empty = $('.col-empty', body);
    if (empty) empty.remove();
    const ref = drop.kids[drop.index];
    if (ref) body.insertBefore(marker, ref); else body.append(marker);
  }

  function autoPanLoop() {
    cancelAnimationFrame(autoPanRaf);
    const step = () => {
      if (!g || g.mode !== 'drag') return;
      if (g.pointer) {
        const r = vpRect(), edge = 36, sp = 9;
        let dx = 0, dy = 0;
        if (g.pointer.cx < r.left + edge) dx = sp; else if (g.pointer.cx > r.right - edge) dx = -sp;
        if (g.pointer.cy < r.top + edge + 50) dy = sp; else if (g.pointer.cy > r.bottom - edge) dy = -sp;
        if (dx || dy) {
          vx += dx; vy += dy; applyView();
          moveDrag({ clientX: g.pointer.cx, clientY: g.pointer.cy });
        }
      }
      autoPanRaf = requestAnimationFrame(step);
    };
    autoPanRaf = requestAnimationFrame(step);
  }

  async function endDrag(commitIt) {
    cancelAnimationFrame(autoPanRaf);
    const { card, el, fromColumn, drop } = g;
    liveRects.delete(card.id);
    el.classList.remove('dragging');
    marker?.remove();
    $$('.card-column.drop-target', world).forEach(x => x.classList.remove('drop-target'));
    g.mode = 'done';
    if (!commitIt) { renderAll(); return; }
    const c = cardOf(card.id);
    const changes = [];
    if (drop) {
      const col = cardOf(drop.colId);
      let items = (col.data.items || []).filter(id => id !== c.id && cardOf(id)?.columnId === col.id);
      const visibleIds = drop.kids.map(k => k.dataset.id);
      const refId = visibleIds[drop.index];
      const idx = refId ? items.indexOf(refId) : items.length;
      items.splice(idx < 0 ? items.length : idx, 0, c.id);
      if (fromColumn && fromColumn !== col.id) {
        const fc = cardOf(fromColumn);
        changes.push(cardDataUpdate(fc, { items: (fc.data.items || []).filter(id => id !== c.id) }));
      }
      changes.push(cardDataUpdate(col, { items }));
      changes.push(cardUpdate(c, { columnId: col.id }));
      // Lines to cards now inside a column still work; they follow the column.
    } else {
      changes.push(cardUpdate(c, { x: snap(g.pos.x), y: snap(g.pos.y), z: maxZ() + 1, columnId: null }));
      if (fromColumn) {
        const fc = cardOf(fromColumn);
        changes.push(cardDataUpdate(fc, { items: (fc.data.items || []).filter(id => id !== c.id) }));
      }
    }
    await commit(changes, { label: 'Move' });
  }

  // ---------- lines: connect, handles ----------
  function startConnect(c) {
    connectFrom = c.id;
    select(null);
    modeBanner.hidden = false;
    modeBanner.replaceChildren(h('span', {}, 'Tap another card to connect it'), h('button', { class: 'btn btn-small', onclick: endConnect }, 'Cancel'));
    els.get(c.id)?.classList.add('connect-source');
  }
  function endConnect() {
    if (connectFrom) els.get(connectFrom)?.classList.remove('connect-source');
    connectFrom = null;
    modeBanner.hidden = true;
  }
  async function makeConnection(fromId, toId) {
    const line = newCard('line', boardId, 0, 0, { from: { id: fromId }, to: { id: toId }, endArrow: true, startArrow: false, style: 'solid', curve: 'straight', weight: 2, label: '' });
    await commit([upd('cards', null, line)], { label: 'Connect' });
    select(line.id);
  }

  function moveHandle(e) {
    const c = cardOf(g.info.lineId);
    const p = toWorld(e.clientX, e.clientY);
    const under = cardUnder(e.clientX, e.clientY, c);
    $$('.card.connect-target', world).forEach(x => x.classList.remove('connect-target'));
    if (under) els.get(under)?.classList.add('connect-target');
    g.preview = { ...c, data: { ...c.data, [g.info.end]: under ? { id: under } : { x: p.x, y: p.y } } };
    state.cards.set(c.id, g.preview);
    drawLines();
    state.cards.set(c.id, c);
  }
  async function endHandle() {
    $$('.card.connect-target', world).forEach(x => x.classList.remove('connect-target'));
    const c = cardOf(g.info.lineId);
    if (g.preview) await commit([upd('cards', c, { ...g.preview, updated: Date.now() })], { label: 'Move line' });
  }
  function cardUnder(cx, cy, exclude) {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const cel = el.closest?.('.card');
      if (cel && cel.dataset.id && world.contains(cel)) return cel.dataset.id;
    }
    return null;
  }

  async function lineArrows(c) {
    const d = c.data;
    const v = await menu('Arrows', [
      { label: 'No arrows', icon: 'minus', value: 'none', active: !d.startArrow && d.endArrow === false },
      { label: 'Arrow at end', icon: 'line', value: 'end', active: !d.startArrow && d.endArrow !== false },
      { label: 'Arrows at both ends', icon: 'move', value: 'both', active: d.startArrow && d.endArrow !== false },
    ]);
    if (!v) return;
    await commit([cardDataUpdate(c, { startArrow: v === 'both', endArrow: v !== 'none' })]);
  }
  async function lineStyle(c) {
    const d = c.data;
    const v = await menu('Line style', [
      { label: 'Straight', icon: 'minus', value: 'straight', active: d.curve !== 'curved' },
      { label: 'Curved', icon: 'sketch', value: 'curved', active: d.curve === 'curved' && (d.bend || 1) > 0 },
      { label: 'Curved the other way', icon: 'sketch', value: 'curved-rev', active: d.curve === 'curved' && (d.bend || 1) < 0 },
      { sep: true },
      { label: 'Solid', icon: 'minus', value: 'solid', active: (d.style || 'solid') === 'solid' },
      { label: 'Dashed', icon: 'minus', value: 'dashed', active: d.style === 'dashed' },
      { label: 'Dotted', icon: 'more', value: 'dotted', active: d.style === 'dotted' },
      { sep: true },
      { label: 'Thin', icon: 'minus', value: 'w1', active: d.weight === 1 },
      { label: 'Medium', icon: 'minus', value: 'w2', active: (d.weight || 2) === 2 },
      { label: 'Thick', icon: 'minus', value: 'w4', active: d.weight === 4 },
    ]);
    if (!v) return;
    const patch = {};
    if (v === 'straight') patch.curve = 'straight';
    if (v === 'curved') { patch.curve = 'curved'; patch.bend = 1; }
    if (v === 'curved-rev') { patch.curve = 'curved'; patch.bend = -1; }
    if (['solid', 'dashed', 'dotted'].includes(v)) patch.style = v;
    if (v.startsWith('w')) patch.weight = Number(v.slice(1));
    await commit([cardDataUpdate(c, patch)]);
  }
  async function lineLabel(c) {
    const t = await promptDialog('Line label', c.data.label || '', { placeholder: 'e.g. leads to' });
    if (t != null) await commit([cardDataUpdate(cardOf(c.id), { label: t.trim() })]);
  }

  // ---------- card actions ----------
  async function colorCard(c) {
    const col = await pickColor(c.color, c.type === 'line' ? 'Line colour' : 'Card colour');
    if (col === undefined) return;
    await commit([cardUpdate(cardOf(c.id), { color: col })], { label: 'Colour' });
  }

  function attachedLines(ids) {
    return [...state.cards.values()].filter(l => l.type === 'line' && (ids.has(l.data.from?.id) || ids.has(l.data.to?.id)));
  }

  async function deleteCard(c) {
    const changes = [];
    const ids = new Set([c.id]);
    if (c.type === 'column') for (const x of state.cards.values()) if (x.columnId === c.id) ids.add(x.id);
    for (const id of ids) changes.push(upd('cards', cardOf(id), null));
    for (const l of attachedLines(ids)) if (!ids.has(l.id)) changes.push(upd('cards', l, null));
    if (c.columnId && cardOf(c.columnId)) {
      const col = cardOf(c.columnId);
      changes.push(cardDataUpdate(col, { items: (col.data.items || []).filter(id => id !== c.id) }));
    }
    if (c.type === 'board' && c.data.boardId) {
      const sub = state.boards.get(c.data.boardId);
      if (sub) {
        const ok = await confirmDialog(`Delete “${sub.name}”?`, 'This deletes the board and everything inside it. You can undo straight afterwards.');
        if (!ok) return;
        changes.push(...await deleteBoardChanges(sub.id));
      }
    }
    select(null);
    await commit(changes, { label: 'Delete' });
    toast(`${TYPE_LABEL[c.type] || 'Card'} deleted`, { label: 'Undo', onClick: doUndo });
  }

  async function duplicateCard(c) {
    const changes = [];
    const copy = structuredClone(c);
    copy.id = db.uid(); copy.x = c.columnId ? c.x : c.x + 24; copy.y = c.columnId ? c.y : c.y + 24; copy.z = maxZ() + 1;
    copy.created = copy.updated = Date.now();
    const d = copy.data;
    if (d.blobId) d.blobId = await duplicateBlob(d.blobId);
    if (d.thumbId) d.thumbId = await duplicateBlob(d.thumbId);
    if (c.type === 'board') {
      const { changes: ch, rootId } = await cloneSubtreeChanges(c.data.boardId, boardId, n => `${n} copy`);
      changes.push(...ch);
      d.boardId = rootId;
    }
    if (c.type === 'column') {
      const newItems = [];
      for (const id of d.items || []) {
        const kid = cardOf(id);
        if (!kid) continue;
        const k = structuredClone(kid);
        k.id = db.uid(); k.columnId = copy.id; k.created = k.updated = Date.now();
        if (k.data.blobId) k.data.blobId = await duplicateBlob(k.data.blobId);
        if (k.data.thumbId) k.data.thumbId = await duplicateBlob(k.data.thumbId);
        newItems.push(k.id);
        changes.push(upd('cards', null, k));
      }
      d.items = newItems;
    }
    if (c.type === 'line') {
      for (const end of ['from', 'to']) {
        const p = endpoint(d[end]);
        d[end] = { x: p.x + 24, y: p.y + 24 };
      }
    }
    changes.push(upd('cards', null, copy));
    if (c.columnId && cardOf(c.columnId)) {
      const col = cardOf(c.columnId);
      const items = [...(col.data.items || [])];
      items.splice(items.indexOf(c.id) + 1, 0, copy.id);
      changes.push(cardDataUpdate(col, { items }));
    }
    await commit(changes, { label: 'Duplicate' });
    select(copy.id);
  }

  async function moreMenu(c) {
    if (!c) return;
    const items = [
      { label: 'Bring to front', icon: 'front', value: 'front' },
      { label: 'Send to back', icon: 'sendback', value: 'back' },
      { label: c.locked ? 'Unlock position' : 'Lock position', icon: c.locked ? 'unlock' : 'lock', value: 'lock' },
      { label: 'Move to another board', icon: 'move', value: 'move' },
      c.columnId ? { label: 'Take out of column', icon: 'column', value: 'uncolumn' } : null,
      { sep: true },
      c.type === 'image' ? { label: 'Caption and source', icon: 'edit', value: 'details' } : null,
      c.type === 'image' || c.type === 'sketch' ? { label: 'Use as board cover', icon: 'board', value: 'cover' } : null,
      ['image', 'sketch', 'file', 'audio'].includes(c.type) ? { label: 'Save a copy to the phone', icon: 'download', value: 'save' } : null,
      ['image', 'sketch', 'file', 'audio'].includes(c.type) && navigator.canShare ? { label: 'Share', icon: 'share', value: 'share' } : null,
      c.type === 'link' ? { label: 'Open link', icon: 'open', value: 'openlink' } : null,
      c.type === 'link' && c.data.url ? { label: 'Copy link', icon: 'copy', value: 'copylink' } : null,
      c.type === 'file' ? { label: 'Rename file', icon: 'edit', value: 'rename' } : null,
      c.type === 'board' ? { label: 'Rename board', icon: 'edit', value: 'renameboard' } : null,
      c.type === 'note' || c.type === 'todo' || c.type === 'heading' ? { label: 'Copy text', icon: 'copy', value: 'copytext' } : null,
      c.type === 'note' ? { label: 'Turn into to-do list', icon: 'todo', value: 'totodo' } : null,
      c.type === 'todo' ? { label: 'Turn into note', icon: 'note', value: 'tonote' } : null,
    ];
    const v = await menu(TYPE_LABEL[c.type] || 'Card', items);
    c = cardOf(c.id);
    if (!v || !c) return;
    if (v === 'front') await commit([cardUpdate(c, { z: maxZ() + 1 })]);
    if (v === 'back') {
      const minZ = Math.min(...[...state.cards.values()].map(x => x.z || 1));
      await commit([cardUpdate(c, { z: minZ - 1 })]);
    }
    if (v === 'lock') { await commit([cardUpdate(c, { locked: !c.locked })]); toast(c.locked ? 'Unlocked' : 'Locked in place'); }
    if (v === 'move') moveCardToBoard(c);
    if (v === 'uncolumn') {
      const col = cardOf(c.columnId), r = worldRect(els.get(col.id));
      await commit([
        cardDataUpdate(col, { items: (col.data.items || []).filter(id => id !== c.id) }),
        cardUpdate(c, { columnId: null, x: snap(r.x + r.w + 24), y: snap(r.y), z: maxZ() + 1 }),
      ], { label: 'Take out of column' });
    }
    if (v === 'details') {
      const r = await editImageDetails(c.data);
      if (r) await commit([cardDataUpdate(c, r)]);
    }
    if (v === 'cover') {
      const b = board();
      await commit([upd('boards', b, { ...b, coverId: c.data.blobId, updated: Date.now() })], { label: 'Set cover' });
      toast('Board cover updated');
    }
    if (v === 'save' || v === 'share') {
      const blob = await db.getBlob(c.data.blobId);
      if (!blob) { toast('This file is missing from storage'); return; }
      const name = c.data.name || `${c.type}-${c.id}.${(blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`;
      if (v === 'share') {
        const f = new File([blob], name, { type: blob.type });
        if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f] }); } catch {} }
        else toast('This file type can’t be shared from the browser. Use “Save a copy” instead.');
      } else {
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: name });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    }
    if (v === 'openlink' && c.data.url) window.open(c.data.url, '_blank', 'noopener');
    if (v === 'copylink') { try { await navigator.clipboard.writeText(c.data.url); toast('Link copied'); } catch {} }
    if (v === 'rename') {
      const t = await promptDialog('Rename file', c.data.name || '');
      if (t != null && t.trim()) await commit([cardDataUpdate(c, { name: t.trim() })]);
    }
    if (v === 'renameboard') {
      const b = state.boards.get(c.data.boardId);
      const t = await promptDialog('Rename board', b?.name || '');
      if (b && t != null && t.trim()) await commit([upd('boards', b, { ...b, name: t.trim(), updated: Date.now() })]);
    }
    if (v === 'copytext') {
      const el = els.get(c.id);
      try { await navigator.clipboard.writeText(el.innerText.trim()); toast('Text copied'); } catch {}
    }
    if (v === 'totodo') {
      // One to-do per line of the note.
      const tmp = h('div', { html: sanitizeHtml(c.data.html || '').replace(/<\/?(br|div|p|li|h\d|blockquote)\b[^>]*>/gi, '\n$&') });
      const lines = tmp.textContent.split('\n').map(s => s.trim()).filter(Boolean);
      await commit([cardUpdate(c, { type: 'todo', data: { title: '', items: lines.map(t => ({ id: db.uid(), text: t, done: false })) } })], { label: 'Convert' });
    }
    if (v === 'tonote') {
      const d = c.data;
      const html = (d.title ? `<h1>${escapeHtml(d.title)}</h1>` : '') + `<ul>${(d.items || []).map(i => `<li>${i.done ? '<s>' : ''}${escapeHtml(i.text)}${i.done ? '</s>' : ''}</li>`).join('')}</ul>`;
      await commit([cardUpdate(c, { type: 'note', data: { html } })], { label: 'Convert' });
    }
  }
  const escapeHtml = s => String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

  async function moveCardToBoard(c) {
    const exclude = new Set([boardId]);
    if (c.type === 'board') {
      // A board can't go inside itself.
      const walk = id => { exclude.add(id); for (const b of state.boards.values()) if (b.parentId === id) walk(b.id); };
      walk(c.data.boardId);
    }
    const target = await pickBoard('Move to board', { exclude });
    if (!target) return;
    const targetCards = await db.getByIndex('cards', 'boardId', target);
    let y = 40, x = 40;
    for (const tc of targetCards) if (!tc.columnId && tc.type !== 'line') y = Math.max(y, tc.y + 260);
    const changes = [];
    const moving = [c];
    if (c.type === 'column') for (const x2 of state.cards.values()) if (x2.columnId === c.id) moving.push(x2);
    for (const m of moving) changes.push(cardUpdate(m, m === c ? { boardId: target, columnId: null, x, y, z: 1 } : { boardId: target }));
    for (const l of attachedLines(new Set(moving.map(m => m.id)))) changes.push(upd('cards', l, null));
    if (c.columnId && cardOf(c.columnId)) {
      const col = cardOf(c.columnId);
      changes.push(cardDataUpdate(col, { items: (col.data.items || []).filter(id => id !== c.id) }));
    }
    if (c.type === 'board') {
      const sub = state.boards.get(c.data.boardId);
      if (sub) changes.push(upd('boards', sub, { ...sub, parentId: target }));
    }
    select(null);
    await commit(changes, { label: 'Move to board' });
    toast(`Moved to “${state.boards.get(target)?.name}”`, { label: 'Undo', onClick: doUndo });
  }

  // ---------- adding ----------
  function addMenu(atPoint = false) {
    if (!atPoint) place = null;
    const grid = h('div', { class: 'add-grid' });
    const s = sheet({ title: 'Add to board', body: grid, className: 'add-sheet', onClose: () => { if (!chosen) place = null; } });
    let chosen = false;
    for (const t of ADD_TYPES) {
      grid.append(h('button', { class: 'add-tile', onclick: () => { chosen = true; s.close(); setTimeout(() => addOfType(t.type), 60); } },
        h('span', { class: `add-ic t-${t.type}`, html: icon(t.icon) }), h('span', {}, t.label)));
    }
  }

  async function createCards(cards, { edit = false, label = 'Add' } = {}) {
    await commit(cards.map(c => upd('cards', null, c)), { label });
    const last = cards[cards.length - 1];
    if (edit) startEdit(last.id);
    else select(last.id);
  }

  async function addOfType(type) {
    const p = nextPlace(newCard(type, boardId, 0, 0).w, type);
    switch (type) {
      case 'note': return createCards([newCard('note', boardId, p.x, p.y, { html: '' })], { edit: true });
      case 'heading': return createCards([newCard('heading', boardId, p.x, p.y, { text: '' })], { edit: true });
      case 'todo': return createCards([newCard('todo', boardId, p.x, p.y, { title: '', items: [] })], { edit: true });
      case 'column': {
        const c = newCard('column', boardId, p.x, p.y, { title: '', items: [], collapsed: false });
        await createCards([c]);
        const t = await promptDialog('Column title', '', { placeholder: 'Optional', okLabel: 'Done' });
        if (t) await commit([cardDataUpdate(cardOf(c.id), { title: t.trim() })], { record: false });
        return;
      }
      case 'image': case 'camera': {
        const files = await pickFiles({ accept: 'image/*', multiple: type === 'image', capture: type === 'camera' ? 'environment' : undefined });
        return addImageFiles(files, p);
      }
      case 'link': {
        const r = await editLink({});
        if (r) return createCards([newCard('link', boardId, p.x, p.y, r)]);
        return;
      }
      case 'swatch': {
        const r = await editSwatch({});
        if (r) return createCards([newCard('swatch', boardId, p.x, p.y, r)]);
        return;
      }
      case 'sketch': {
        const r = await sketchPad(null);
        if (r) return createCards([newCard('sketch', boardId, p.x, p.y, r)]);
        return;
      }
      case 'comment': {
        const r = await editComments([]);
        if (r && r.length) return createCards([newCard('comment', boardId, p.x, p.y, { entries: r })]);
        return;
      }
      case 'board': {
        const name = await promptDialog('New board', '', { placeholder: 'Board name', okLabel: 'Create' });
        if (!name || !name.trim()) return;
        const b = newBoard(name.trim(), boardId);
        const c = newCard('board', boardId, p.x, p.y, { boardId: b.id });
        await commit([upd('boards', null, b), upd('cards', null, c)], { label: 'Add board' });
        select(c.id);
        return;
      }
      case 'line': {
        const line = newCard('line', boardId, 0, 0, { from: { x: p.x, y: p.y + 60 }, to: { x: p.x + 200, y: p.y + 60 }, endArrow: true, startArrow: false, style: 'solid', curve: 'straight', weight: 2, label: '' });
        await commit([upd('cards', null, line)], { label: 'Add line' });
        select(line.id);
        toast('Drag the ends of the line onto cards to attach it');
        return;
      }
      case 'file': {
        const files = await pickFiles({ accept: '*/*', multiple: true });
        return addFileCards(files, p);
      }
      case 'audio': {
        const r = await recordVoice();
        if (r) return createCards([newCard('audio', boardId, p.x, p.y, r)]);
        return;
      }
      case 'paste': return pasteFromClipboard(p);
    }
  }

  async function addImageFiles(files, p = null) {
    files = files.filter(f => f && (f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|avif|bmp|svg)$/i.test(f.name)));
    if (!files.length) return;
    if (files.length > 2) toast(`Adding ${files.length} images…`);
    const cards = [];
    const extra = [];
    const cw = 260;
    let first = p;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const { blob, w, h: ih } = await processImage(f, settings.optimiseImages);
      const blobId = await saveBlob(blob, f.name);
      const hgt = ih && w ? Math.round((cw * ih) / w) : cw;
      // First image goes where asked (long-press spot); the rest find space nearby.
      const pos = first ? { x: snap(first.x), y: snap(first.y) } : freeSpot(cw, hgt, extra);
      first = null;
      const c = newCard('image', boardId, pos.x, pos.y, { blobId, w, h: ih, caption: '', source: '' });
      c.z += i;
      extra.push({ x: pos.x, y: pos.y, w: cw, h: hgt });
      cards.push(c);
    }
    await createCards(cards, { label: files.length > 1 ? 'Add images' : 'Add image' });
    if (files.length > 1) toast(`${files.length} images added`);
  }

  async function addFileCards(files, p = null) {
    files = files.filter(Boolean);
    if (!files.length) return;
    const cards = [];
    const extra = [];
    for (const f of files) {
      const blobId = await saveBlob(f, f.name);
      const isAudio = f.type.startsWith('audio/');
      const hgt = f.type.startsWith('video/') ? 230 : isAudio ? 120 : 80;
      const pos = p ? { x: snap(p.x), y: snap(p.y) } : freeSpot(240, hgt, extra);
      p = null;
      extra.push({ x: pos.x, y: pos.y, w: 240, h: hgt });
      cards.push(newCard(isAudio ? 'audio' : 'file', boardId, pos.x, pos.y, { blobId, name: f.name, mime: f.type, size: f.size }));
    }
    await createCards(cards, { label: 'Add file' });
  }

  async function addFromText(text, p = nextPlace(240, 'link')) {
    text = (text || '').trim();
    if (!text) return;
    const urlMatch = text.match(/https?:\/\/\S+/);
    if (isUrl(text) || (urlMatch && text.length < urlMatch[0].length + 120)) {
      const url = normaliseUrl(urlMatch ? urlMatch[0] : text);
      const rest = text.replace(urlMatch ? urlMatch[0] : text, '').trim();
      return createCards([newCard('link', boardId, p.x, p.y, { url, title: rest || hostOf(url), description: '' })]);
    }
    const html = text.split(/\n/).map(l => `<div>${escapeHtml(l) || '<br>'}</div>`).join('');
    return createCards([newCard('note', boardId, p.x, p.y, { html })]);
  }

  async function pasteFromClipboard(p) {
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        const images = [];
        let text = '';
        for (const it of items) {
          const imgType = it.types.find(t => t.startsWith('image/'));
          if (imgType) images.push(new File([await it.getType(imgType)], `pasted.${imgType.split('/')[1]}`, { type: imgType }));
          else if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
        }
        if (images.length) return addImageFiles(images, p);
        if (text) return addFromText(text, p);
      } else if (navigator.clipboard?.readText) {
        const t = await navigator.clipboard.readText();
        if (t) return addFromText(t, p);
      }
      toast('The clipboard is empty');
    } catch {
      toast('Clipboard access was blocked. Allow it when the browser asks, or paste into a note instead.');
    }
  }

  // Desktop: paste an image or text straight onto the board.
  const onDocPaste = e => {
    if (editingId || document.querySelector('.overlay')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addImageFiles(files); return; }
    const t = e.clipboardData?.getData('text/plain');
    if (t) { e.preventDefault(); addFromText(t); }
  };
  document.addEventListener('paste', onDocPaste);

  const onKey = e => {
    if (document.querySelector('.overlay') || editingId) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteCard(cardOf(selectedId)); }
    if (e.key === 'Escape') { if (connectFrom) endConnect(); else if (selectedId) select(null); }
  };
  document.addEventListener('keydown', onKey);

  // ---------- undo / board-level ----------
  function updateUndoButtons() {
    undoBtn.disabled = !state.undo.length;
    redoBtn.disabled = !state.redo.length;
  }
  async function doUndo() {
    if (editingId) stopEdit();
    const r = await undo();
    if (!r) toast('Nothing to undo');
  }
  async function doRedo() {
    const r = await redo();
    if (!r) toast('Nothing to redo');
  }

  function goUp() {
    if (editingId) stopEdit();
    const b = board();
    onNavigate(b?.parentId && state.boards.get(b.parentId) ? { board: b.parentId } : { home: true });
  }

  async function renameBoard() {
    const b = board();
    const t = await promptDialog('Rename board', b.name);
    if (t != null && t.trim()) await commit([upd('boards', b, { ...b, name: t.trim(), updated: Date.now() })], { label: 'Rename board' });
  }

  async function boardMenu() {
    if (editingId) stopEdit();
    const b = board();
    const v = await menu(b.name, [
      { label: 'Rename board', icon: 'edit', value: 'rename' },
      { label: 'Board colour', icon: 'palette', value: 'color' },
      { label: 'Background', icon: 'grid', value: 'bg', hint: { dots: 'Dots', grid: 'Grid', lines: 'Lines', plain: 'Plain' }[b.bg || 'dots'] },
      { label: settings.snap ? 'Turn off snap to grid' : 'Turn on snap to grid', icon: 'grid', value: 'snap' },
      { label: 'Fit everything on screen', icon: 'fit', value: 'fit' },
      b.coverId ? { label: 'Reset board cover', icon: 'board', value: 'uncover' } : null,
      { sep: true },
      { label: 'Duplicate board', icon: 'copy', value: 'dup' },
      { label: 'Export this board', icon: 'download', value: 'export', hint: 'Zip file' },
      { sep: true },
      { label: 'Delete board', icon: 'trash', value: 'delete', danger: true },
    ]);
    if (!v) return;
    if (v === 'rename') renameBoard();
    if (v === 'color') {
      const col = await pickColor(b.color, 'Board colour');
      if (col !== undefined) await commit([upd('boards', b, { ...b, color: col })]);
    }
    if (v === 'bg') {
      const bg = await menu('Background', [
        { label: 'Dots', icon: 'more', value: 'dots', active: (b.bg || 'dots') === 'dots' },
        { label: 'Grid', icon: 'grid', value: 'grid', active: b.bg === 'grid' },
        { label: 'Lines', icon: 'ul', value: 'lines', active: b.bg === 'lines' },
        { label: 'Plain', icon: 'minus', value: 'plain', active: b.bg === 'plain' },
      ]);
      if (bg) await commit([upd('boards', board(), { ...board(), bg })], { label: 'Background' });
    }
    if (v === 'snap') {
      settings.snap = !settings.snap;
      await db.saveSettings({ snap: settings.snap });
      toast(settings.snap ? 'Snap to grid on' : 'Snap to grid off');
    }
    if (v === 'fit') fitAll(true);
    if (v === 'uncover') await commit([upd('boards', b, { ...b, coverId: null })]);
    if (v === 'dup') {
      const { changes, rootId } = await cloneSubtreeChanges(boardId, b.parentId, n => `${n} copy`);
      if (b.parentId) {
        // Place a card for the copy next to the original's card in the parent board.
        const parentCards = await db.getByIndex('cards', 'boardId', b.parentId);
        const orig = parentCards.find(pc => pc.type === 'board' && pc.data.boardId === boardId);
        const card = { ...newCard('board', b.parentId, (orig?.x ?? 40) + 24, (orig?.y ?? 40) + 24, { boardId: rootId }), z: (orig?.z || 1) + 1 };
        changes.push(upd('cards', null, card));
      }
      await commit(changes, { record: false });
      toast('Board duplicated', { label: 'Open', onClick: () => onNavigate({ board: rootId }) });
    }
    if (v === 'export') exportFlow(boardId);
    if (v === 'delete') {
      const ok = await confirmDialog(`Delete “${b.name}”?`, 'This deletes the board and everything inside it, including boards within it. This can’t be undone, so back up first if you might want it later.');
      if (!ok) return;
      const changes = await deleteBoardChanges(boardId);
      if (b.parentId) {
        const parentCards = await db.getByIndex('cards', 'boardId', b.parentId);
        for (const pc of parentCards) if (pc.type === 'board' && pc.data.boardId === boardId) changes.push(upd('cards', pc, null));
      }
      await commit(changes, { record: false });
      toast('Board deleted');
      onNavigate(b.parentId && state.boards.get(b.parentId) ? { board: b.parentId } : { home: true });
    }
  }

  // ---------- react to store changes ----------
  const unsub = subscribe(changes => {
    let redrawAll = false;
    const touched = new Set();
    for (const ch of changes) {
      if (ch.store === 'boards') {
        if (ch.id === boardId) {
          if (!ch.after) return;
          if (!ch.silent) renderTitle();
        }
        // A sub-board shown as a card changed: refresh its tile.
        for (const c of state.cards.values()) if (c.type === 'board' && c.data.boardId === ch.id) touched.add(c.id);
        continue;
      }
      if (ch.store !== 'cards') continue;
      const before = ch.before, after = ch.after;
      const inBoard = v => v && v.boardId === boardId;
      if (!inBoard(before) && !inBoard(after)) continue;
      if (before?.columnId) touched.add(before.columnId);
      if (after?.columnId) touched.add(after.columnId);
      if (!inBoard(after)) { removeEl(ch.id); if (selectedId === ch.id) selectedId = null; if (editingId === ch.id) { editingId = null; hideFormatBar(); } continue; }
      if (before?.type !== after.type) { removeEl(ch.id); }
      touched.add(ch.id);
    }
    if (redrawAll) renderAll();
    else {
      // Parents first so children can be placed inside columns.
      const list = [...touched].map(id => cardOf(id)).filter(Boolean).sort((a, b) => (a.type === 'column' ? -1 : 0) - (b.type === 'column' ? -1 : 0));
      for (const c of list) {
        if (c.columnId && !cardOf(c.columnId)) { renderCard({ ...c, columnId: null }, true); continue; }
        if (c.columnId) continue; // drawn by its column
        renderCard(c, true);
      }
      for (const c of list) if (c.columnId && cardOf(c.columnId) && !list.includes(cardOf(c.columnId))) renderCard(cardOf(c.columnId), true);
    }
    if (selectedId && !cardOf(selectedId)) selectedId = null;
    updateEmpty();
    updateUndoButtons();
    renderCtx();
    scheduleLines();
  });

  // ---------- initial paint ----------
  renderTitle();
  renderAll();
  updateUndoButtons();
  const v0 = board()?.view;
  if (v0) { vx = v0.x; vy = v0.y; vs = v0.s; applyView(); }
  else requestAnimationFrame(() => fitAll(false));
  applyView();

  return {
    async addFiles(files) {
      const imgs = files.filter(f => f.type.startsWith('image/'));
      const others = files.filter(f => !f.type.startsWith('image/'));
      if (imgs.length) await addImageFiles(imgs);
      if (others.length) await addFileCards(others);
    },
    addText: t => addFromText(t),
    focusCard(id) {
      const c = cardOf(id);
      if (!c) return;
      requestAnimationFrame(() => { centerOn(c.columnId || id); select(id); });
    },
    destroy() {
      if (editingId) stopEdit();
      unsub();
      ro.disconnect();
      document.removeEventListener('paste', onDocPaste);
      document.removeEventListener('keydown', onKey);
      window.visualViewport?.removeEventListener('resize', onVV);
      cancelAnimationFrame(autoPanRaf);
      view.remove();
      closeBoard();
      releaseUrls();
    },
  };
}

export { CARD_COLORS };
