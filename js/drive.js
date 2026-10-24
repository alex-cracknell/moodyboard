// Google Drive access from the browser: sign-in through Google Identity Services
// and a few Drive API calls. Uses the drive.file permission, so the app can only
// see files it created itself.
import { GOOGLE_CLIENT_ID } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_KEY = 'moodboard-drive-token';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const driveConfigured = () => !!GOOGLE_CLIENT_ID;

export class AuthError extends Error {}

// ---------- token ----------
function readToken() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; }
}
function writeToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, JSON.stringify(t)) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
export function hasValidToken() {
  const t = readToken();
  return !!(t && t.access_token && t.expires_at - 60_000 > Date.now());
}
function accessToken() {
  const t = readToken();
  if (!t || t.expires_at - 30_000 < Date.now()) throw new AuthError('Signed out of Google Drive');
  return t.access_token;
}

let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new Error('Couldn’t reach Google. Check the internet connection.')); };
    document.head.append(s);
  });
  return gisPromise;
}

let tokenClient = null;
let pending = null;

// Opens Google's sign-in window. Must be called from a tap.
export async function signIn({ hint = '', consent = false } = {}) {
  if (!driveConfigured()) throw new Error('Google Drive sync isn’t set up in this copy of the app.');
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
        const p = pending; pending = null;
        if (!p) return;
        if (resp.error) { p.reject(new AuthError(resp.error_description || resp.error)); return; }
        const t = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
        writeToken(t);
        p.resolve(t);
      },
      error_callback: err => {
        const p = pending; pending = null;
        if (!p) return;
        p.reject(new AuthError(err?.type === 'popup_closed' ? 'Sign-in was cancelled' : (err?.message || 'Sign-in failed')));
      },
    });
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: consent ? 'consent' : '', login_hint: hint || undefined });
  });
}

export async function signOut() {
  const t = readToken();
  writeToken(null);
  if (t?.access_token && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(t.access_token, () => {}); } catch {}
  }
}

// ---------- API ----------
async function call(url, opts = {}, { raw = false } = {}) {
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken()}` } });
  if (res.status === 401) { writeToken(null); throw new AuthError('Google Drive sign-in expired'); }
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    const e = new Error(`Google Drive: ${msg}`);
    e.status = res.status;
    throw e;
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function list(query, fields = 'id,name,mimeType,modifiedTime,version,appProperties,size') {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ q: query, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces: 'drive' });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await call(`${API}/files?${params}`);
    out.push(...(r.files || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function findChild(parentId, name, mime) {
  const parts = [`name = '${q(name)}'`, `'${parentId}' in parents`, 'trashed = false'];
  if (mime) parts.push(`mimeType = '${mime}'`);
  const r = await list(parts.join(' and '));
  return r[0] || null;
}

export async function ensureFolder(name, parentId = 'root') {
  const found = await findChild(parentId, name, FOLDER_MIME);
  if (found) return found.id;
  const r = await call(`${API}/files?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return r.id;
}

export async function getMeta(fileId, fields = 'id,name,version,modifiedTime,trashed') {
  return call(`${API}/files/${fileId}?fields=${fields}`);
}

// Resumable upload works for any size and for both new files and updates.
async function resumable(url, method, metadata, blob) {
  const type = blob.type || 'application/octet-stream';
  const start = await call(url, {
    method,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify(metadata || {}),
  }, { raw: true });
  const location = start.headers.get('location');
  if (!location) throw new Error('Google Drive didn’t accept the upload.');
  const res = await fetch(location, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
  if (res.status === 401) { writeToken(null); throw new AuthError('Google Drive sign-in expired'); }
  if (!res.ok) throw new Error(`Google Drive upload failed (${res.status})`);
  return res.json();
}

export function uploadNew(name, parentId, blob, appProperties) {
  return resumable(`${UPLOAD}/files?uploadType=resumable&fields=id,version`, 'POST', { name, parents: [parentId], appProperties }, blob);
}

export function updateContent(fileId, blob) {
  return resumable(`${UPLOAD}/files/${fileId}?uploadType=resumable&fields=id,version`, 'PATCH', {}, blob);
}

export async function download(fileId, type) {
  const res = await call(`${API}/files/${fileId}?alt=media`, {}, { raw: true });
  const blob = await res.blob();
  return type && blob.type !== type ? new Blob([blob], { type }) : blob;
}

export async function trash(fileId) {
  try {
    await call(`${API}/files/${fileId}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  } catch (e) { if (e.status !== 404) throw e; }
}

export async function shareLink(fileId) {
  await call(`${API}/files/${fileId}/permissions?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  const r = await getMeta(fileId, 'webViewLink');
  return r.webViewLink;
}

export async function whoAmI() {
  const r = await call(`${API}/about?fields=user(emailAddress,displayName)`);
  return r.user || {};
}
