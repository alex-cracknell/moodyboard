import { h, $ } from './util.js';
import { icon } from './icons.js';
import * as db from './db.js';
import { state, loadBoards, subscribe, collectGarbage, newBoard, commit, upd, rootBoards, boardPath } from './store.js';
import { mountBoard } from './canvas.js';
import { mountHome, applyTheme } from './home.js';
import { handlePop, closeAllOverlays, historySettled, sheet, toast, promptDialog } from './ui.js';
import { setOnDataReplaced } from './backup-ui.js';
import { initSync, schedule as scheduleSync } from './sync.js';

const app = $('#app');
let current = null;      // { kind: 'home'|'board', api, id }
let deferredInstall = null;
let renderSeq = 0;

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
window.addEventListener('appinstalled', () => { deferredInstall = null; toast('App installed'); });

function routeFromHash() {
  const m = location.hash.match(/^#b\/([\w-]+)/);
  return m ? { board: m[1] } : { home: true };
}
function hashFor(route) { return route.board ? `#b/${route.board}` : '#'; }

export async function navigate(route, { replace = false } = {}) {
  closeAllOverlays();
  // Overlays remove their history entries asynchronously; wait so ours isn't popped by mistake.
  await historySettled();
  const st = { route };
  if (replace) history.replaceState(st, '', hashFor(route) || '#');
  else history.pushState(st, '', hashFor(route) || '#');
  return render(route);
}

async function render(route) {
  const seq = ++renderSeq;
  if (route.reload) await loadBoards();
  if (route.board && !state.boards.has(route.board)) route = { home: true };
  if (current) {
    if (current.kind === 'board' && route.board === current.id) {
      if (route.focus) current.api.focusCard(route.focus);
      return;
    }
    current.api.destroy();
    current = null;
  }
  if (seq !== renderSeq) return;
  if (route.board) {
    const api = await mountBoard(app, route.board, { onNavigate: r => navigate(r) });
    if (seq !== renderSeq) { api.destroy(); return; }
    current = { kind: 'board', id: route.board, api };
    document.title = `${state.boards.get(route.board)?.name || 'Board'} · Moodboard`;
    if (route.focus) api.focusCard(route.focus);
  } else {
    const api = mountHome(app, { onNavigate: r => navigate(r), installPrompt: () => deferredInstall });
    current = { kind: 'home', api };
    document.title = 'Moodboard';
  }
  return current;
}

window.addEventListener('popstate', e => {
  if (handlePop()) return;
  const route = e.state?.route || routeFromHash();
  render(route);
});

// Home screen refreshes when boards change (e.g. undoing a delete).
let homeTimer = null;
subscribe(() => {
  if (current?.kind !== 'home') return;
  clearTimeout(homeTimer);
  homeTimer = setTimeout(() => current?.kind === 'home' && current.api.refresh(), 60);
});

setOnDataReplaced(async () => {
  await loadBoards();
  scheduleSync(1000);
  if (current) { current.api.destroy(); current = null; }
  navigate({ home: true }, { replace: true });
});

// ---------- items shared into the app from other apps ----------
async function checkInbox() {
  const items = await db.getAll('inbox');
  if (!items.length) return;
  const files = items.flatMap(i => i.files || []);
  const texts = items.map(i => [i.title, i.text, i.url].filter(Boolean).join('\n').trim()).filter(Boolean);
  const clear = () => db.clearAll(['inbox']);
  const summary = [files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '', texts.length ? `${texts.length} link or text item${texts.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  const list = h('div', { class: 'menu-list' });
  let handled = false;
  const go = async boardId => {
    handled = true;
    s.close();
    await clear();
    if (location.search) history.replaceState(history.state, '', location.pathname + location.hash);
    await navigate({ board: boardId });
    if (current?.kind !== 'board' || current.id !== boardId) return;
    if (files.length) await current.api.addFiles(files);
    for (const t of texts) await current.api.addText(t);
  };
  list.append(h('button', { class: 'menu-item', onclick: async () => {
    handled = true;
    s.close();
    const name = await promptDialog('New board', 'Inbox', { okLabel: 'Create' });
    if (!name) { await clear(); toast('Shared items discarded'); return; }
    const b = newBoard(name.trim() || 'Inbox', null);
    await commit([upd('boards', null, b)], { record: false });
    go(b.id);
  } }, h('span', { class: 'menu-ic', html: icon('plus') }), h('span', {}, 'New board…')));
  const boards = [...state.boards.values()].map(b => ({ b, path: boardPath(b.id).map(x => x.name).join(' / ') })).sort((a, c) => (c.b.updated || 0) - (a.b.updated || 0));
  for (const { b, path } of boards) list.append(h('button', { class: 'menu-item', onclick: () => go(b.id) }, h('span', { class: 'menu-ic', html: icon('board') }), h('span', { class: 'menu-path' }, path)));
  const s = sheet({
    title: 'Add shared items',
    body: [h('p', { class: 'sheet-text' }, `Choose a board for ${summary}.`), list],
    onClose: async () => { if (!handled) { await clear(); toast('Shared items discarded'); } },
  });
}

// ---------- boot ----------
async function boot() {
  const settings = await db.getSettings();
  applyTheme(settings.theme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => applyTheme((await db.getSettings()).theme));
  if (!settings.firstUseAt) await db.saveSettings({ firstUseAt: Date.now() });
  await loadBoards();
  const route = routeFromHash();
  history.replaceState({ route }, '', location.hash || '#');
  await render(route);
  // Ask the browser to keep our storage. Chrome decides silently.
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
  setTimeout(() => collectGarbage().catch(() => {}), 3000);
  initSync().catch(() => {});
  checkInbox().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      location.reload();
    });
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('An update is ready', { label: 'Reload', onClick: () => { (reg.waiting || w).postMessage('skip-waiting'); } });
          }
        });
      });
    }).catch(() => {});
  }
}

boot().catch(err => {
  app.innerHTML = '';
  app.append(h('div', { class: 'fatal' }, h('h1', {}, 'The app couldn’t start'), h('p', {}, String(err?.message || err)),
    h('p', {}, 'If you’re in a private window, storage may be blocked. Open the app in a normal Chrome tab.')));
});
