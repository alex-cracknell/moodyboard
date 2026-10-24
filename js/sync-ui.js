import { h, relativeTime, formatBytes } from './util.js';
import { icon } from './icons.js';
import { sheet, toast, toggle } from './ui.js';
import * as sync from './sync.js';

// Small cloud button for the home header and board top bar.
export function syncButton() {
  const btn = h('button', { class: 'sync-btn', hidden: true });
  const unsub = sync.onStatus(st => {
    const map = {
      idle: ['cloudcheck', '', `Synced${st.lastSyncAt ? ' ' + relativeTime(st.lastSyncAt) : ''}`],
      syncing: ['refresh', '', st.message || 'Syncing…'],
      'needs-auth': ['cloud', 'Sync', 'Tap to sync with Google Drive'],
      offline: ['cloudoff', '', 'Offline'],
      error: ['cloudalert', '', 'Sync problem'],
    };
    const m = map[st.state];
    btn.hidden = !m;
    if (!m) return;
    btn.className = `sync-btn s-${st.state}`;
    btn.setAttribute('aria-label', m[2]);
    btn.title = m[2];
    btn.innerHTML = icon(m[0]) + (m[1] ? `<span>${m[1]}</span>` : '') + (st.progress ? `<span class="sync-prog">${st.progress}</span>` : '');
  });
  btn.addEventListener('click', async () => {
    const st = sync.getStatus();
    if (st.state === 'needs-auth') { await sync.syncNow().catch(() => {}); return; }
    if (st.state === 'syncing') return;
    syncSheet();
  });
  btn.destroy = unsub;
  return btn;
}

export async function syncSheet() {
  const body = h('div', { class: 'settings' });
  const s = sheet({ title: 'Google Drive sync', body });
  const draw = async () => {
    body.replaceChildren(await syncSection(draw, () => s.close()));
  };
  draw();
  const off = sync.onStatus(() => { if (!s.closed) draw(); else off(); });
}

// Used both in Settings and in the sheet opened from the cloud button.
export async function syncSection(redraw = () => {}) {
  const wrap = h('div', { class: 'reminder-controls' });
  if (!sync.isConfigured()) {
    wrap.append(h('p', { class: 'set-hint' }, 'Sync isn’t set up in this copy of the app yet. Whoever hosts it needs to add a Google client ID to js/config.js (see SETUP-GOOGLE-DRIVE.md).'));
    return wrap;
  }
  const st = sync.getStatus();
  const s = await sync.syncSettings();
  if (!s?.connected) {
    wrap.append(
      h('p', { class: 'set-hint' }, 'Keep your boards in step between this phone and your other devices, using your own Google Drive. The app creates a “Moodboard” folder and can only see what it puts there.'),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        try { await sync.connect(); toast('Google Drive connected'); } catch (e) { toast(e.message || 'Couldn’t connect'); }
        redraw();
      } }, h('span', { html: icon('cloud') }), 'Connect Google Drive'),
    );
    if (st.state === 'off' && st.message) wrap.append(h('p', { class: 'set-hint warn' }, st.message));
    return wrap;
  }
  const line = {
    idle: `Up to date. Last synced ${relativeTime(st.lastSyncAt || s.lastSyncAt)}.`,
    syncing: st.message || 'Syncing…',
    'needs-auth': 'Google needs you to confirm it’s you before the next sync. Tap Sync now.',
    offline: 'You’re offline. Changes are saved on this device and will sync when you’re back online.',
    error: st.message || 'The last sync didn’t finish.',
  }[st.state] || '';
  wrap.append(
    h('div', { class: 'set-row' }, h('span', { class: 'set-text' },
      h('span', {}, s.email ? `Connected as ${s.email}` : 'Connected'),
      h('span', { class: `set-hint ${st.state === 'error' ? 'warn' : ''}` }, line))),
    h('div', { class: 'set-buttons' },
      h('button', { class: 'btn btn-primary', disabled: st.state === 'syncing', onclick: async () => {
        try { await sync.syncNow(); } catch {}
        redraw();
      } }, h('span', { html: icon('refresh') }), 'Sync now'),
    ),
    h('label', { class: 'set-row' }, h('span', { class: 'set-text' }, h('span', {}, 'Weekly backup in Drive'),
      h('span', { class: 'set-hint' }, `Saves a full backup zip to Moodboard › backups once a week and keeps the newest 4.${s.lastDriveBackupAt ? ` Last one ${relativeTime(s.lastDriveBackupAt)}.` : ''}`)),
      toggle(s.weeklyBackup !== false, v => sync.setWeeklyBackup(v))),
    h('div', { class: 'set-buttons' },
      h('button', { class: 'btn', onclick: async () => {
        toast('Saving a backup to Drive…');
        try { await sync.driveBackupNow(); toast('Backup saved to Drive'); } catch (e) { toast(e.message); }
        redraw();
      } }, 'Back up to Drive now'),
      h('button', { class: 'btn', onclick: async () => {
        await sync.disconnect();
        toast('Disconnected. Your boards stay on this device and in Drive.');
        redraw();
      } }, 'Disconnect'),
    ),
  );
  return wrap;
}

// "Share a copy" of one board: zip in Drive with a link anyone can open.
export async function shareBoardFlow(boardId, boardName) {
  if (!sync.isConfigured() || !(await sync.isConnected())) return false;
  const status = h('p', { class: 'sheet-text' }, `Putting a copy of “${boardName}” in your Google Drive…`);
  const actions = h('div', { class: 'export-actions' });
  const s = sheet({ title: 'Share a copy', body: [status, actions] });
  try {
    const { link, filename, size } = await sync.shareBoardCopy(boardId);
    if (s.closed) return true;
    status.replaceChildren(
      h('strong', {}, filename), h('br'),
      `${formatBytes(size)} · anyone with the link can download it, then open it in Moodboard with Settings › Import a backup › Add to my boards.`,
    );
    if (navigator.share) {
      actions.append(bigBtn('share', 'Send the link', 'Messages, WhatsApp, email…', async () => {
        try { await navigator.share({ title: `${boardName} (Moodboard)`, text: `A copy of my “${boardName}” moodboard`, url: link }); } catch {}
      }));
    }
    actions.append(bigBtn('copy', 'Copy the link', link.replace(/^https?:\/\//, '').slice(0, 42) + '…', async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast(link); }
    }));
    actions.append(h('p', { class: 'form-hint' }, 'The copy won’t change if you edit the board later. To stop sharing, delete the file from Moodboard › shared in Google Drive.'));
  } catch (e) {
    status.textContent = `Couldn’t share: ${e.message}`;
  }
  return true;
}

function bigBtn(ic, label, hint, onclick) {
  return h('button', { class: 'big-btn', onclick }, h('span', { class: 'big-ic', html: icon(ic) }), h('span', { class: 'big-text' }, h('span', {}, label), h('span', { class: 'big-hint' }, hint)));
}
