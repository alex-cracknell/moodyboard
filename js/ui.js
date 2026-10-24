import { h, $ } from './util.js';
import { icon } from './icons.js';

// ---------- overlay stack with Android back-button support ----------
const overlays = [];
let ignorePops = 0;
let histQ = Promise.resolve();
let popWaiter = null;

function waitPop() {
  return new Promise(res => { popWaiter = res; setTimeout(res, 400); });
}

export function overlayCount() { return overlays.length; }

// Called by the router's popstate handler. Returns true if the pop was consumed.
export function handlePop() {
  if (popWaiter) { const w = popWaiter; popWaiter = null; w(); }
  if (ignorePops > 0) { ignorePops--; return true; }
  if (overlays.length) {
    const top = overlays[overlays.length - 1];
    top._close(true);
    return true;
  }
  return false;
}

function pushOverlay(o) {
  overlays.push(o);
  histQ = histQ.then(() => {
    if (o.closed) return;
    history.pushState({ ...(history.state || {}), overlay: overlays.length }, '');
    o.pushed = true;
  });
}

function popOverlay(o, fromBack) {
  const i = overlays.indexOf(o);
  if (i >= 0) overlays.splice(i, 1);
  histQ = histQ.then(async () => {
    if (o.pushed && !fromBack) {
      ignorePops++;
      const w = waitPop();
      history.back();
      await w;
    }
  });
}

// Resolves once pending history changes from overlays have finished.
export function historySettled() { return histQ; }

export function closeAllOverlays() {
  for (const o of [...overlays].reverse()) o._close(false);
}

// ---------- bottom sheet ----------
export function sheet({ title, body, actions, className = '', onClose, full = false, dismissible = true }) {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const panel = h('div', { class: `sheet ${full ? 'sheet-full' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });
  const head = h('div', { class: 'sheet-head' },
    h('div', { class: 'sheet-grip' }),
    title ? h('h2', { class: 'sheet-title' }, title) : null,
    h('button', { class: 'icon-btn sheet-x', 'aria-label': 'Close', html: icon('x'), onclick: () => o.close() }),
  );
  const content = h('div', { class: 'sheet-body' });
  if (body) content.append(...(Array.isArray(body) ? body : [body]));
  panel.append(head, content);
  if (actions && actions.length) {
    const foot = h('div', { class: 'sheet-foot' });
    for (const a of actions) {
      foot.append(h('button', {
        class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`,
        onclick: async () => { const r = await a.onClick?.(o); if (r !== false) o.close(); },
      }, a.label));
    }
    panel.append(foot);
  }
  const root = h('div', { class: 'overlay' }, backdrop, panel);
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add('open'));
  if (dismissible) backdrop.addEventListener('click', () => o.close());

  const o = {
    el: panel, body: content, root, closed: false,
    close() { o._close(false); },
    _close(fromBack) {
      if (o.closed) return;
      o.closed = true;
      popOverlay(o, fromBack);
      root.classList.remove('open');
      root.classList.add('closing');
      setTimeout(() => root.remove(), 220);
      onClose && onClose();
    },
  };
  pushOverlay(o);
  return o;
}

// Full-screen layer (sketch pad, image viewer). Same back-button behaviour.
export function layer(className, onClose) {
  const root = h('div', { class: `layer ${className}` });
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add('open'));
  const o = {
    el: root, closed: false,
    close() { o._close(false); },
    _close(fromBack) {
      if (o.closed) return;
      o.closed = true;
      popOverlay(o, fromBack);
      root.remove();
      onClose && onClose();
    },
  };
  pushOverlay(o);
  return o;
}

// A back-button stop with no visible panel (e.g. leaving inline text editing).
export function backGuard(onBack) {
  const o = {
    closed: false,
    close() { o._close(false); },
    _close(fromBack) {
      if (o.closed) return;
      o.closed = true;
      popOverlay(o, fromBack);
      if (fromBack) onBack && onBack();
    },
  };
  pushOverlay(o);
  return o;
}

// ---------- action menu ----------
export function menu(title, items) {
  return new Promise(resolve => {
    let chosen = null;
    const list = h('div', { class: 'menu-list' });
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { list.append(h('div', { class: 'menu-sep' })); continue; }
      list.append(h('button', {
        class: `menu-item ${it.danger ? 'danger' : ''} ${it.active ? 'active' : ''}`,
        onclick: () => { chosen = it.value ?? it.label; s.close(); },
      }, h('span', { class: 'menu-ic', html: icon(it.icon || 'dot') }), h('span', {}, it.label), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null));
    }
    const s = sheet({ title, body: list, onClose: () => resolve(chosen) });
  });
}

export function confirmDialog(title, message, okLabel = 'Delete', danger = true) {
  return new Promise(resolve => {
    let ok = false;
    sheet({
      title,
      body: h('p', { class: 'sheet-text' }, message),
      actions: [
        { label: 'Cancel' },
        { label: okLabel, primary: !danger, danger, onClick: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

export function promptDialog(title, value = '', { placeholder = '', okLabel = 'Save', multiline = false } = {}) {
  return new Promise(resolve => {
    let result = null;
    const input = multiline
      ? h('textarea', { class: 'field', rows: 4, placeholder })
      : h('input', { class: 'field', type: 'text', placeholder, enterkeyhint: 'done' });
    input.value = value;
    const s = sheet({
      title,
      body: input,
      actions: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    if (!multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter') { result = input.value; s.close(); } });
    setTimeout(() => { input.focus(); input.select?.(); }, 250);
  });
}

// ---------- toast ----------
let toastEl = null, toastTimer = null;
export function toast(message, action) {
  if (toastEl) toastEl.remove();
  clearTimeout(toastTimer);
  toastEl = h('div', { class: 'toast', role: 'status' },
    h('span', {}, message),
    action ? h('button', { class: 'toast-btn', onclick: () => { action.onClick(); hide(); } }, action.label) : null,
  );
  document.body.append(toastEl);
  requestAnimationFrame(() => toastEl && toastEl.classList.add('show'));
  const el = toastEl;
  const hide = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 200); if (toastEl === el) toastEl = null; };
  toastTimer = setTimeout(hide, action ? 6000 : 2600);
}

export function field(label, input, hint) {
  return h('label', { class: 'form-row' }, h('span', { class: 'form-label' }, label), input, hint ? h('span', { class: 'form-hint' }, hint) : null);
}

export function toggle(checked, onChange) {
  const input = h('input', { type: 'checkbox', class: 'switch' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

export function pickFiles({ accept = '*/*', multiple = false, capture } = {}) {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    if (multiple) input.multiple = true;
    if (capture) input.setAttribute('capture', capture);
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    // Some browsers never fire change on cancel; that just leaves a pending promise.
    document.body.append(input);
    input.click();
  });
}
