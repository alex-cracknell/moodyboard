import { h, formatBytes, relativeTime } from './util.js';
import { icon } from './icons.js';
import { sheet, toast, pickFiles, confirmDialog } from './ui.js';
import * as db from './db.js';
import {
  buildBackup, canPickSaveLocation, canShareFile, saveWithPicker, shareFile, downloadFile, markBackedUp,
  inspectBackup, restoreBackup, REMINDER_OPTIONS, reminderDue, snoozeReminder,
} from './backup.js';
import { state } from './store.js';

let onDataReplaced = () => {};
export function setOnDataReplaced(fn) { onDataReplaced = fn; }

// Two steps: build the file, then let the person choose where it goes
// (saving or sharing needs a fresh tap, which building the file would use up).
export async function exportFlow(boardId = null) {
  const status = h('p', { class: 'sheet-text' }, 'Preparing your backup…');
  const bar = h('div', { class: 'progress' }, h('span'));
  const actions = h('div', { class: 'export-actions' });
  const s = sheet({ title: boardId ? 'Export board' : 'Back up', body: [status, bar, actions] });
  let result;
  try {
    result = await buildBackup(boardId, (n, total) => { bar.firstChild.style.width = `${(n / total) * 100}%`; });
  } catch (err) {
    status.textContent = `The backup couldn’t be created: ${err.message}`;
    bar.remove();
    return;
  }
  if (s.closed) return;
  bar.remove();
  const { blob, filename, counts } = result;
  status.replaceChildren(
    h('strong', {}, filename), h('br'),
    `${counts.boards} board${counts.boards === 1 ? '' : 's'}, ${counts.cards} card${counts.cards === 1 ? '' : 's'}, ${counts.files} file${counts.files === 1 ? '' : 's'} · ${formatBytes(blob.size)}`,
  );
  const done = async how => {
    if (!boardId) await markBackedUp();
    toast(how);
    s.close();
    document.dispatchEvent(new CustomEvent('backup-done'));
  };
  if (canPickSaveLocation()) {
    actions.append(bigBtn('download', 'Save to a folder', 'Choose where on the phone it goes', async () => {
      try { await saveWithPicker(blob, filename); await done('Backup saved'); }
      catch (e) { if (e.name !== 'AbortError') toast(`Couldn’t save: ${e.message}`); }
    }));
  }
  if (canShareFile(blob, filename)) {
    actions.append(bigBtn('share', 'Share or save to…', 'Drive, Files, email, another app', async () => {
      try { await shareFile(blob, filename); await done('Backup shared'); }
      catch (e) { if (e.name !== 'AbortError') toast(`Couldn’t share: ${e.message}`); }
    }));
  }
  actions.append(bigBtn('download', 'Download', 'Saves to your Downloads folder', async () => {
    downloadFile(blob, filename);
    await done('Backup downloaded');
  }));
  actions.append(h('p', { class: 'form-hint' }, 'Keep a copy somewhere off the phone too, like Google Drive or your computer, so a lost phone doesn’t mean lost boards.'));
}

function bigBtn(ic, label, hint, onclick) {
  return h('button', { class: 'big-btn', onclick }, h('span', { class: 'big-ic', html: icon(ic) }), h('span', { class: 'big-text' }, h('span', {}, label), h('span', { class: 'big-hint' }, hint)));
}

export async function importFlow() {
  const [file] = await pickFiles({ accept: '.zip,application/zip,application/x-zip-compressed' });
  if (!file) return;
  let pack;
  try { pack = await inspectBackup(file); }
  catch (err) { toast(err.message); return; }
  const m = pack.manifest;
  const c = m.counts || { boards: m.boards.length, cards: m.cards.length, files: m.blobs.length };
  const when = m.exportedAt ? new Date(m.exportedAt).toLocaleString() : 'unknown date';
  let mode = null;
  await new Promise(resolve => {
    const s2 = sheet({
      title: 'Import backup',
      body: [
        h('p', { class: 'sheet-text' }, h('strong', {}, file.name), h('br'),
          `${m.scope === 'board' ? 'One board' : 'Full backup'} from ${when}: ${c.boards} board${c.boards === 1 ? '' : 's'}, ${c.cards} cards, ${c.files} files.`),
        bigBtn('plus', 'Add to my boards', 'Keeps what’s here; boards from the backup are added or updated', () => { mode = 'merge'; s2.close(); }),
        bigBtn('backup', 'Replace everything', 'Deletes what’s on this phone first, then restores the backup', () => { mode = 'replace'; s2.close(); }),
      ],
      onClose: resolve,
    });
  });
  if (!mode) return;
  if (mode === 'replace' && state.boards.size) {
    const ok = await confirmDialog('Replace everything?', 'All boards on this phone will be deleted and replaced with the backup. This can’t be undone.', 'Replace');
    if (!ok) return;
  }
  const status = h('p', { class: 'sheet-text' }, 'Importing…');
  const bar = h('div', { class: 'progress' }, h('span'));
  const s = sheet({ title: 'Importing', body: [status, bar], dismissible: false });
  try {
    const r = await restoreBackup(pack, mode, (n, total) => { bar.firstChild.style.width = `${(n / Math.max(1, total)) * 100}%`; });
    s.close();
    toast(`Imported ${r.boards} board${r.boards === 1 ? '' : 's'}`);
    onDataReplaced();
  } catch (err) {
    status.textContent = `Import stopped: ${err.message}`;
    bar.remove();
  }
}

// ---------- reminder banner ----------
export async function showReminderIfDue(container) {
  container.querySelector('.reminder')?.remove();
  if (!(await reminderDue())) return;
  const s = await db.getSettings();
  const banner = h('div', { class: 'reminder', role: 'status' },
    h('span', { class: 'reminder-ic', html: icon('backup') }),
    h('div', { class: 'reminder-text' },
      h('strong', {}, 'Time for a backup'),
      h('span', {}, s.lastBackupAt ? `Last backed up ${relativeTime(s.lastBackupAt)}.` : 'Your boards haven’t been backed up yet.'),
      h('span', { class: 'reminder-links' },
        h('button', { class: 'link-btn strong', onclick: () => exportFlow(null) }, 'Back up now'),
        h('button', { class: 'link-btn', onclick: () => reminderSettings() }, 'Reminder settings'),
      ),
    ),
    h('button', { class: 'icon-btn reminder-x', 'aria-label': 'Dismiss reminder', html: icon('x'), onclick: async () => {
      await snoozeReminder();
      banner.classList.add('leaving');
      setTimeout(() => banner.remove(), 200);
    } }),
  );
  container.prepend(banner);
}

export async function reminderSettings() {
  const s = await db.getSettings();
  const body = h('div', {});
  const draw = () => {
    body.innerHTML = '';
    body.append(reminderControls(s, draw));
  };
  draw();
  sheet({ title: 'Backup reminders', body, onClose: () => document.dispatchEvent(new CustomEvent('backup-done')) });
}

export function reminderControls(s, redraw) {
  const wrap = h('div', { class: 'reminder-controls' });
  const sw = h('input', { type: 'checkbox', class: 'switch' });
  sw.checked = s.reminderEnabled;
  sw.addEventListener('change', async () => { await db.saveSettings({ reminderEnabled: sw.checked, reminderSnoozedUntil: 0 }); redraw && redraw(); });
  wrap.append(h('label', { class: 'set-row' }, h('span', { class: 'set-text' }, h('span', {}, 'Remind me to back up'), h('span', { class: 'set-hint' }, 'Shows a banner on the home screen. Only when something has changed since your last backup.')), sw));
  if (s.reminderEnabled) {
    const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'How often' });
    for (const o of REMINDER_OPTIONS) {
      seg.append(h('button', {
        class: `seg ${s.reminderDays === o.days ? 'active' : ''}`, role: 'radio', 'aria-checked': String(s.reminderDays === o.days),
        onclick: async () => { await db.saveSettings({ reminderDays: o.days, reminderSnoozedUntil: 0 }); redraw && redraw(); },
      }, o.label));
    }
    wrap.append(h('div', { class: 'set-sub' }, seg));
  }
  wrap.append(h('p', { class: 'form-hint' }, s.lastBackupAt ? `Last backup: ${new Date(s.lastBackupAt).toLocaleString()}` : 'No backup made yet.'));
  return wrap;
}
