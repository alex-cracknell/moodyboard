export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'H1', 'H2', 'H3', 'P', 'DIV', 'BR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'SPAN', 'CODE', 'MARK']);
// Keep formatting from notes, drop anything that could run code.
export function sanitizeHtml(html = '') {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        if (!ALLOWED.has(child.tagName)) {
          if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(child.tagName)) { child.remove(); continue; }
          walk(child);
          child.replaceWith(...child.childNodes);
          continue;
        }
        for (const a of [...child.attributes]) {
          const keep = child.tagName === 'A' && a.name === 'href' && /^(https?:|mailto:)/i.test(a.value);
          if (!keep) child.removeAttribute(a.name);
        }
        if (child.tagName === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener'); }
        walk(child);
      } else if (child.nodeType !== 3) child.remove();
    }
  };
  const root = doc.body.firstChild;
  walk(root);
  return root.innerHTML;
}

export function htmlToText(html = '') {
  const d = document.createElement('div');
  d.innerHTML = sanitizeHtml(html.replace(/<(br|\/p|\/div|\/li|\/h\d)>/gi, '$& '));
  return d.textContent.replace(/\s+/g, ' ').trim();
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function relativeTime(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function isUrl(s) {
  return /^(https?:\/\/|www\.)\S+$/i.test(String(s).trim());
}
export function normaliseUrl(s) {
  s = String(s).trim();
  if (!s) return '';
  if (/^www\./i.test(s)) s = 'https://' + s;
  if (!/^[a-z]+:/i.test(s)) s = 'https://' + s;
  return s;
}
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
export function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

const MAX_DIM = 2000;
// Shrink big photos and convert to WebP. GIFs and SVGs are kept as they are.
export async function processImage(file, optimise = true) {
  const keep = !optimise || /gif|svg/.test(file.type);
  let w = 0, hgt = 0;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = bmp.width; hgt = bmp.height;
    if (!keep && (w > MAX_DIM || hgt > MAX_DIM || file.size > 600 * 1024)) {
      const scale = Math.min(1, MAX_DIM / Math.max(w, hgt));
      const cw = Math.round(w * scale), ch = Math.round(hgt * scale);
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
      bmp.close && bmp.close();
      const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.86));
      if (blob && blob.size < file.size) return { blob, w: cw, h: ch };
      return { blob: file, w, h: hgt };
    }
    bmp.close && bmp.close();
  } catch {
    // Unknown format: store it untouched; dimensions get read when shown.
  }
  return { blob: file, w, h: hgt };
}

export function extForMime(mime = '') {
  const m = {
    'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
    'video/webm': 'webm', 'application/pdf': 'pdf', 'text/plain': 'txt',
  };
  return m[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function vibrate(ms = 10) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }
