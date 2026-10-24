import { h, $, debounce, formatBytes, relativeTime, vibrate } from './util.js';
import { icon } from './icons.js';
import * as db from './db.js';
import { state, rootBoards, newBoard, commit, upd, deleteBoardChanges, cloneSubtreeChanges, collectGarbage, boardPath, loadBoards } from './store.js';
import { fillBoardCover, cardSearchText, TYPE_LABEL } from './cards.js';
import { sheet, menu, toast, confirmDialog, promptDialog, toggle } from './ui.js';
import { pickColor } from './editors.js';
import { exportFlow, importFlow, showReminderIfDue, reminderControls } from './backup-ui.js';

export const APP_VERSION = '1.0.0';

export function mountHome(root, { onNavigate, installPrompt }) {
  const reminderSlot = h('div', { class: 'reminder-slot' });
  const search = h('input', { class: 'search-input', type: 'search', placeholder: 'Search boards and cards', 'aria-label': 'Search boards and cards', enterkeyhint: 'search' });
  const grid = h('div', { class: 'board-grid' });
  const results = h('div', { class: 'search-results', hidden: true });
  const header = h('header', { class: 'home-head' },
    h('div', { class: 'home-title-row' },
      h('h1', { class: 'home-title' }, 'Moodboards'),
      h('button', { class: 'icon-btn', 'aria-label': 'Settings and backup', html: icon('settings'), onclick: () => openSettings({ onNavigate, installPrompt }) }),
    ),
    h('label', { class: 'search-wrap' }, h('span', { html: icon('search') }), search),
  );
  const fab = h('button', { class: 'fab', onclick: createBoard }, h('span', { html: icon('plus') }), h('span', {}, 'New board'));
  const view = h('div', { class: 'home-view' }, header, h('main', { class: 'home-main' }, reminderSlot, grid, results), fab);
  root.append(view);

  async function createBoard() {
    const name = await promptDialog('New board', '', { placeholder: 'e.g. Living room, Album art, Garden', okLabel: 'Create' });
    if (!name || !name.trim()) return;
    const b = newBoard(name.trim(), null);
    await commit([upd('boards', null, b)], { record: false });
    onNavigate({ board: b.id });
  }

  function render() {
    grid.innerHTML = '';
    const boards = rootBoards();
    if (!boards.length) {
      grid.append(h('div', { class: 'home-empty' },
        h('div', { class: 'home-empty-art', html: emptyArt() }),
        h('h2', {}, 'Start your first board'),
        h('p', {}, 'Collect images, notes, links, colours and sketches on an open canvas. Everything stays on this phone.'),
        h('div', { class: 'home-empty-actions' },
          h('button', { class: 'btn btn-primary', onclick: createBoard }, 'New board'),
          h('button', { class: 'btn', onclick: importFlow }, 'Restore a backup'),
        ),
      ));
      fab.hidden = true;
      return;
    }
    fab.hidden = false;
    for (const b of boards) grid.append(tile(b));
  }

  function tile(b) {
    const cover = h('div', { class: 'board-cover' });
    const meta = h('span', { class: 'tile-meta' });
    const t = h('div', { class: `tile ${b.color ? 'color-' + b.color : ''}`, role: 'button', tabindex: '0' },
      cover,
      h('div', { class: 'tile-foot' },
        h('div', { class: 'tile-text' }, h('span', { class: 'tile-name' }, b.name || 'Untitled board'), meta),
        h('button', { class: 'icon-btn tile-more', 'aria-label': `Options for ${b.name}`, html: icon('more'), onclick: e => { e.stopPropagation(); tileMenu(b); } }),
      ),
    );
    fillBoardCover(b.id, cover, null).then(async () => {
      const cards = await db.getByIndex('cards', 'boardId', b.id);
      const n = cards.filter(c => c.type !== 'line').length;
      meta.textContent = `${n} card${n === 1 ? '' : 's'} · ${relativeTime(b.updated)}`;
    });
    let timer = null, moved = false, sx = 0, sy = 0;
    t.addEventListener('pointerdown', e => {
      moved = false; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { timer = null; moved = true; vibrate(15); tileMenu(b); }, 520);
    });
    t.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clearTimeout(timer); moved = true; } });
    t.addEventListener('pointerup', () => clearTimeout(timer));
    t.addEventListener('pointercancel', () => { clearTimeout(timer); moved = true; });
    t.addEventListener('contextmenu', e => e.preventDefault());
    t.addEventListener('click', () => { if (!moved) onNavigate({ board: b.id }); });
    t.addEventListener('keydown', e => { if (e.key === 'Enter') onNavigate({ board: b.id }); });
    return t;
  }

  async function tileMenu(b) {
    const v = await menu(b.name, [
      { label: 'Open', icon: 'open', value: 'open' },
      { label: 'Rename', icon: 'edit', value: 'rename' },
      { label: 'Colour', icon: 'palette', value: 'color' },
      { label: 'Duplicate', icon: 'copy', value: 'dup' },
      { label: 'Export this board', icon: 'download', value: 'export', hint: 'Zip file' },
      { sep: true },
      { label: 'Delete', icon: 'trash', value: 'delete', danger: true },
    ]);
    if (v === 'open') onNavigate({ board: b.id });
    if (v === 'rename') {
      const t = await promptDialog('Rename board', b.name);
      if (t != null && t.trim()) await commit([upd('boards', b, { ...b, name: t.trim(), updated: Date.now() })], { record: false });
    }
    if (v === 'color') {
      const c = await pickColor(b.color, 'Board colour');
      if (c !== undefined) await commit([upd('boards', b, { ...b, color: c })], { record: false });
    }
    if (v === 'dup') {
      const { changes } = await cloneSubtreeChanges(b.id, null, n => `${n} copy`);
      await commit(changes, { record: false });
      toast('Board duplicated');
    }
    if (v === 'export') exportFlow(b.id);
    if (v === 'delete') {
      const ok = await confirmDialog(`Delete “${b.name}”?`, 'This deletes the board and everything inside it, including boards within it.');
      if (!ok) return;
      const changes = await deleteBoardChanges(b.id);
      await commit(changes, { record: false });
      toast('Board deleted', {
        label: 'Undo', onClick: async () => {
          await commit(changes.map(c => ({ ...c, before: c.after, after: c.before })), { record: false });
        },
      });
    }
    render();
  }

  // ---------- search ----------
  let allCards = null;
  const runSearch = debounce(async () => {
    const q = search.value.trim().toLowerCase();
    if (!q) { results.hidden = true; grid.hidden = false; reminderSlot.hidden = false; return; }
    grid.hidden = true; reminderSlot.hidden = true; results.hidden = false;
    if (!allCards) allCards = await db.getAll('cards');
    const boardHits = [...state.boards.values()].filter(b => (b.name || '').toLowerCase().includes(q));
    const cardHits = [];
    for (const c of allCards) {
      if (!state.boards.has(c.boardId)) continue;
      const text = cardSearchText(c);
      const i = text.toLowerCase().indexOf(q);
      if (i >= 0) cardHits.push({ c, text, i });
      if (cardHits.length > 80) break;
    }
    results.innerHTML = '';
    if (!boardHits.length && !cardHits.length) {
      results.append(h('p', { class: 'muted search-none' }, `Nothing matches “${search.value.trim()}”.`));
      return;
    }
    if (boardHits.length) {
      results.append(h('h2', { class: 'result-head' }, 'Boards'));
      for (const b of boardHits) results.append(h('button', { class: 'result', onclick: () => onNavigate({ board: b.id }) },
        h('span', { class: 'result-ic', html: icon('board') }),
        h('span', { class: 'result-text' }, h('span', { class: 'result-main' }, b.name), h('span', { class: 'result-sub' }, boardPath(b.id).slice(0, -1).map(x => x.name).join(' / ') || 'Home'))));
    }
    if (cardHits.length) {
      results.append(h('h2', { class: 'result-head' }, 'Cards'));
      for (const { c, text, i } of cardHits) {
        const start = Math.max(0, i - 30);
        const snippet = (start ? '…' : '') + text.slice(start, i + q.length + 60).trim();
        results.append(h('button', { class: 'result', onclick: () => onNavigate({ board: c.boardId, focus: c.id }) },
          h('span', { class: 'result-ic', html: icon({ todo: 'todo', link: 'link', image: 'image', swatch: 'swatch', comment: 'comment', file: 'file', audio: 'mic', heading: 'heading', column: 'column', line: 'line' }[c.type] || 'note') }),
          h('span', { class: 'result-text' }, h('span', { class: 'result-main' }, snippet),
            h('span', { class: 'result-sub' }, `${TYPE_LABEL[c.type]} in ${boardPath(c.boardId).map(x => x.name).join(' / ')}`))));
      }
    }
  }, 180);
  search.addEventListener('input', () => { allCards = null; runSearch(); });

  const refreshReminder = () => showReminderIfDue(reminderSlot);
  document.addEventListener('backup-done', refreshReminder);

  render();
  refreshReminder();
  return {
    refresh() { render(); refreshReminder(); },
    destroy() { document.removeEventListener('backup-done', refreshReminder); view.remove(); },
  };
}

function emptyArt() {
  return `<svg viewBox="0 0 220 150" aria-hidden="true">
    <rect x="18" y="26" width="78" height="58" rx="6" class="ea-card ea-tilt1"/>
    <rect x="26" y="34" width="62" height="34" rx="3" class="ea-img"/>
    <rect x="112" y="16" width="86" height="40" rx="6" class="ea-card ea-yellow"/>
    <rect x="122" y="28" width="52" height="5" rx="2.5" class="ea-ink"/>
    <rect x="122" y="38" width="36" height="5" rx="2.5" class="ea-ink"/>
    <rect x="118" y="72" width="40" height="40" rx="6" class="ea-swatch"/>
    <rect x="166" y="72" width="32" height="56" rx="6" class="ea-card"/>
    <rect x="34" y="98" width="70" height="34" rx="6" class="ea-card"/>
    <circle cx="46" cy="110" r="4" class="ea-ink"/><rect x="56" y="108" width="36" height="4" rx="2" class="ea-ink"/>
    <circle cx="46" cy="122" r="4" class="ea-ink"/><rect x="56" y="120" width="26" height="4" rx="2" class="ea-ink"/>
    <path d="M96 60 Q108 66 112 46" class="ea-line"/>
  </svg>`;
}

// ---------- settings ----------
export async function openSettings({ onNavigate, installPrompt } = {}) {
  const s = await db.getSettings();
  const body = h('div', { class: 'settings' });
  const draw = async () => {
    body.innerHTML = '';
    // Backups
    body.append(h('section', { class: 'set-group' },
      h('h3', {}, 'Backups'),
      h('div', { class: 'set-buttons' },
        h('button', { class: 'btn btn-primary', onclick: () => exportFlow(null) }, h('span', { html: icon('download') }), 'Back up now'),
        h('button', { class: 'btn', onclick: () => importFlow() }, h('span', { html: icon('upload') }), 'Import a backup'),
      ),
      reminderControls(s, draw),
    ));
    // Appearance
    const theme = h('div', { class: 'segmented' });
    for (const [v, l] of [['system', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']]) {
      theme.append(h('button', { class: `seg ${s.theme === v ? 'active' : ''}`, onclick: async () => { await db.saveSettings({ theme: v }); applyTheme(v); draw(); } }, l));
    }
    body.append(h('section', { class: 'set-group' },
      h('h3', {}, 'Appearance'),
      h('div', { class: 'set-row' }, h('span', { class: 'set-text' }, h('span', {}, 'Theme'))), theme,
    ));
    // Boards
    body.append(h('section', { class: 'set-group' },
      h('h3', {}, 'Boards'),
      h('label', { class: 'set-row' }, h('span', { class: 'set-text' }, h('span', {}, 'Snap to grid'), h('span', { class: 'set-hint' }, 'Cards line up neatly when you move or resize them.')),
        toggle(s.snap, v => db.saveSettings({ snap: v }))),
      h('label', { class: 'set-row' }, h('span', { class: 'set-text' }, h('span', {}, 'Shrink large photos'), h('span', { class: 'set-hint' }, 'Saves space by resizing photos to 2000px and converting them to WebP. Turn off to keep originals.')),
        toggle(s.optimiseImages, v => db.saveSettings({ optimiseImages: v }))),
    ));
    // Storage
    const usage = h('p', { class: 'set-hint' }, 'Checking storage…');
    const persistLine = h('p', { class: 'set-hint' });
    body.append(h('section', { class: 'set-group' },
      h('h3', {}, 'Storage on this phone'),
      usage, persistLine,
      h('div', { class: 'set-buttons' },
        h('button', { class: 'btn', onclick: async () => {
          const n = await collectGarbage();
          toast(n ? `Removed ${n} unused file${n === 1 ? '' : 's'}` : 'Nothing to clean up');
          draw();
        } }, 'Clean up unused files'),
      ),
    ));
    fillStorage(usage, persistLine);
    // Install
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!standalone) {
      body.append(h('section', { class: 'set-group' },
        h('h3', {}, 'Install'),
        h('p', { class: 'set-hint' }, 'Install the app to your home screen. It then opens full screen, works offline, and the browser is far less likely to clear its storage.'),
        installPrompt?.() ? h('button', { class: 'btn btn-primary', onclick: async () => { const p = installPrompt(); if (p) { p.prompt(); await p.userChoice; } } }, 'Install app')
          : h('p', { class: 'set-hint' }, 'In Chrome, open the ⋮ menu and choose “Add to home screen” or “Install app”.'),
      ));
    }
    // Danger
    body.append(h('section', { class: 'set-group danger-zone' },
      h('h3', {}, 'Delete everything'),
      h('p', { class: 'set-hint' }, 'Removes every board, card and file from this phone. Back up first if you might want them again.'),
      h('button', { class: 'btn btn-danger', onclick: async () => {
        const ok = await confirmDialog('Delete everything?', 'Every board, card and file on this phone will be deleted. This can’t be undone.', 'Delete everything');
        if (!ok) return;
        await db.clearAll(['boards', 'cards', 'blobs']);
        await loadBoards();
        sh.close();
        toast('All data deleted');
        onNavigate?.({ home: true, reload: true });
      } }, 'Delete all data'),
    ));
    body.append(h('p', { class: 'about' }, `Moodboard ${APP_VERSION} · Everything is stored only in this browser on this device.`));
  };
  const sh = sheet({ title: 'Settings', body, full: true, onClose: () => document.dispatchEvent(new CustomEvent('backup-done')) });
  draw();
}

async function fillStorage(usage, persistLine) {
  try {
    const est = await navigator.storage?.estimate?.();
    const [cards, blobs] = await Promise.all([db.getAllKeys('cards'), db.getAllKeys('blobs')]);
    usage.textContent = est
      ? `Using ${formatBytes(est.usage)} for ${state.boards.size} boards, ${cards.length} cards and ${blobs.length} files. About ${formatBytes(Math.max(0, est.quota - est.usage))} more is available.`
      : `${state.boards.size} boards, ${cards.length} cards, ${blobs.length} files.`;
    const persisted = await navigator.storage?.persisted?.();
    persistLine.replaceChildren(persisted
      ? 'Storage is marked as persistent, so the browser won’t clear it to free up space.'
      : 'Storage isn’t marked as persistent yet, so the browser could clear it if the phone runs very low on space. Installing the app usually fixes this.');
    if (!persisted && navigator.storage?.persist) {
      persistLine.append(' ', h('button', { class: 'link-btn strong', onclick: async () => {
        const ok = await navigator.storage.persist();
        toast(ok ? 'Storage is now persistent' : 'The browser said no. Install the app and try again.');
        fillStorage(usage, persistLine);
      } }, 'Ask again'));
    }
  } catch {
    usage.textContent = 'Storage details aren’t available in this browser.';
  }
}

export function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#16191f' : '#e7eaee';
}
