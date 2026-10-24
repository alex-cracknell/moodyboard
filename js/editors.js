import { h, normaliseUrl, isUrl, hostOf, formatDate, processImage } from './util.js';
import { icon } from './icons.js';
import { sheet, layer, field, toast, pickFiles } from './ui.js';
import { CARD_COLORS } from './cards.js';
import { state, saveBlob, blobUrl, boardPath } from './store.js';
import * as db from './db.js';

// ---------- link ----------
export function editLink(data = {}) {
  return new Promise(resolve => {
    let result = null;
    const url = h('input', { class: 'field', type: 'url', inputmode: 'url', placeholder: 'https://…', enterkeyhint: 'next' });
    const title = h('input', { class: 'field', type: 'text', placeholder: 'Shown as the card heading' });
    const desc = h('textarea', { class: 'field', rows: 3, placeholder: 'Optional' });
    url.value = data.url || ''; title.value = data.title || ''; desc.value = data.description || '';
    let thumbId = data.thumbId || null;
    const thumbPrev = h('div', { class: 'thumb-prev' });
    const drawThumb = () => {
      thumbPrev.innerHTML = '';
      if (thumbId) {
        const img = h('img', { alt: '' });
        blobUrl(thumbId).then(u => { img.src = u; });
        thumbPrev.append(img, h('button', { class: 'btn btn-small', onclick: () => { thumbId = null; drawThumb(); } }, 'Remove picture'));
      } else {
        thumbPrev.append(h('button', { class: 'btn btn-small', onclick: async () => {
          const [f] = await pickFiles({ accept: 'image/*' });
          if (!f) return;
          const s = await db.getSettings();
          const { blob } = await processImage(f, s.optimiseImages);
          thumbId = await saveBlob(blob, f.name);
          drawThumb();
        } }, h('span', { html: icon('image') }), 'Add a picture'));
      }
    };
    drawThumb();
    url.addEventListener('blur', () => { if (url.value && !title.value) title.value = hostOf(normaliseUrl(url.value)); });
    const s = sheet({
      title: data.url ? 'Edit link' : 'Add link',
      body: [
        field('Web address', url),
        field('Title', title),
        field('Description', desc),
        field('Picture', thumbPrev, 'Websites don’t let the app fetch previews, so add your own picture if you want one. YouTube links show their thumbnail automatically.'),
      ],
      actions: [{ label: 'Cancel' }, {
        label: 'Save', primary: true, onClick: () => {
          if (!url.value.trim()) { toast('Enter a web address first'); return false; }
          const u = normaliseUrl(url.value);
          result = { url: u, title: title.value.trim() || hostOf(u), description: desc.value.trim(), thumbId };
        },
      }],
      onClose: () => resolve(result),
    });
    setTimeout(() => (data.url ? title : url).focus(), 250);
  });
}

// ---------- colour swatch ----------
export function editSwatch(data = {}) {
  return new Promise(resolve => {
    let result = null;
    const picker = h('input', { type: 'color', class: 'color-input' });
    const hex = h('input', { class: 'field mono', type: 'text', maxlength: 7, autocapitalize: 'off', spellcheck: 'false' });
    const name = h('input', { class: 'field', type: 'text', placeholder: 'e.g. Faded denim' });
    picker.value = data.hex || '#7fa7c9';
    hex.value = picker.value.toUpperCase();
    name.value = data.name || '';
    const preview = h('div', { class: 'swatch-preview', style: { background: picker.value } });
    picker.addEventListener('input', () => { hex.value = picker.value.toUpperCase(); preview.style.background = picker.value; });
    hex.addEventListener('input', () => {
      let v = hex.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) { picker.value = v.toLowerCase(); preview.style.background = v; }
    });
    const eyedrop = 'EyeDropper' in window
      ? h('button', { class: 'btn btn-small', onclick: async () => {
        try { const r = await new window.EyeDropper().open(); picker.value = r.sRGBHex; picker.dispatchEvent(new Event('input')); } catch {}
      } }, 'Pick from screen') : null;
    sheet({
      title: data.hex ? 'Edit colour' : 'Add colour',
      body: [preview, h('div', { class: 'swatch-row' }, picker, hex, eyedrop), field('Name', name)],
      actions: [{ label: 'Cancel' }, {
        label: 'Save', primary: true, onClick: () => {
          if (!/^#[0-9a-f]{6}$/i.test(picker.value)) { toast('Enter a 6-digit colour code like #A1B2C3'); return false; }
          result = { hex: picker.value.toLowerCase(), name: name.value.trim() };
        },
      }],
      onClose: () => resolve(result),
    });
  });
}

// ---------- image details ----------
export function editImageDetails(data = {}) {
  return new Promise(resolve => {
    let result = null;
    const caption = h('textarea', { class: 'field', rows: 2, placeholder: 'Optional' });
    const source = h('input', { class: 'field', type: 'url', inputmode: 'url', placeholder: 'Where it came from (optional)' });
    caption.value = data.caption || ''; source.value = data.source || '';
    sheet({
      title: 'Image details',
      body: [field('Caption', caption), field('Source link', source)],
      actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => {
        result = { caption: caption.value.trim(), source: source.value.trim() ? normaliseUrl(source.value) : '' };
      } }],
      onClose: () => resolve(result),
    });
  });
}

// ---------- comment thread ----------
export function editComments(entries = []) {
  return new Promise(resolve => {
    let list = entries.map(e => ({ ...e }));
    let changed = false;
    const box = h('div', { class: 'thread' });
    const draw = () => {
      box.innerHTML = '';
      if (!list.length) box.append(h('p', { class: 'sheet-text muted' }, 'No comments yet.'));
      for (const e of list) {
        box.append(h('div', { class: 'thread-entry' },
          h('div', { class: 'thread-text' }, e.text),
          h('div', { class: 'thread-foot' }, h('span', {}, formatDate(e.at)),
            h('button', { class: 'link-btn', onclick: () => { list = list.filter(x => x !== e); changed = true; draw(); } }, 'Remove')),
        ));
      }
      box.scrollTop = box.scrollHeight;
    };
    draw();
    const input = h('textarea', { class: 'field', rows: 2, placeholder: 'Write a comment' });
    const add = () => {
      const t = input.value.trim();
      if (!t) return;
      list.push({ id: db.uid(), text: t, at: Date.now() });
      input.value = ''; changed = true; draw();
    };
    sheet({
      title: 'Comments',
      body: [box, h('div', { class: 'thread-add' }, input, h('button', { class: 'btn btn-primary', onclick: add }, 'Add'))],
      actions: [{ label: 'Done', primary: true, onClick: () => { if (input.value.trim()) add(); } }],
      onClose: () => resolve(changed || input.value.trim() ? list : null),
    });
    setTimeout(() => input.focus(), 250);
  });
}

// ---------- colour picker for cards / boards ----------
export function pickColor(current, title = 'Card colour') {
  return new Promise(resolve => {
    let result;
    const grid = h('div', { class: 'color-grid' });
    const s = sheet({ title, body: grid, onClose: () => resolve(result) });
    const opt = (id, label) => h('button', {
      class: `color-opt ${current === id ? 'active' : ''}`, 'data-color': id || 'none', 'aria-label': label,
      onclick: () => { result = id; s.close(); },
    }, h('span', { class: 'color-dot' }), h('span', {}, label));
    grid.append(opt(null, 'None'), ...CARD_COLORS.map(c => opt(c.id, c.label)));
  });
}

// ---------- board picker ----------
export function pickBoard(title, { exclude = new Set(), allowHome = false } = {}) {
  return new Promise(resolve => {
    let result;
    const list = h('div', { class: 'menu-list' });
    const s = sheet({ title, body: list, onClose: () => resolve(result) });
    if (allowHome) list.append(h('button', { class: 'menu-item', onclick: () => { result = 'home'; s.close(); } }, h('span', { class: 'menu-ic', html: icon('home') }), h('span', {}, 'New board on home')));
    const boards = [...state.boards.values()].filter(b => !exclude.has(b.id))
      .map(b => ({ b, path: boardPath(b.id).map(x => x.name).join(' / ') }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (!boards.length) list.append(h('p', { class: 'sheet-text muted' }, 'No other boards yet.'));
    for (const { b, path } of boards) {
      list.append(h('button', { class: 'menu-item', onclick: () => { result = b.id; s.close(); } },
        h('span', { class: 'menu-ic', html: icon('board') }), h('span', { class: 'menu-path' }, path)));
    }
  });
}

// ---------- image viewer ----------
export async function viewImage(blobId, caption) {
  const url = await blobUrl(blobId);
  if (!url) return;
  const o = layer('viewer');
  const img = h('img', { src: url, alt: caption || '', draggable: 'false' });
  const stage = h('div', { class: 'viewer-stage' }, img);
  o.el.append(
    stage,
    h('div', { class: 'viewer-bar' },
      h('button', { class: 'icon-btn on-dark', 'aria-label': 'Close', html: icon('x'), onclick: () => o.close() }),
      caption ? h('div', { class: 'viewer-cap' }, caption) : h('div', { class: 'grow' }),
    ),
  );
  // Pinch to zoom, drag to pan, double-tap to toggle zoom.
  let s = 1, tx = 0, ty = 0;
  const pts = new Map();
  let start = null, lastTap = 0;
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`; };
  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start = { s, tx, ty, pts: new Map([...pts].map(([k, v]) => [k, { ...v }])) };
    if (pts.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { if (s > 1) { s = 1; tx = ty = 0; } else { s = 2.5; } apply(); }
      lastTap = now;
    }
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cur = [...pts.values()], st = [...start.pts.values()];
    if (cur.length >= 2 && st.length >= 2) {
      const d0 = Math.hypot(st[0].x - st[1].x, st[0].y - st[1].y);
      const d1 = Math.hypot(cur[0].x - cur[1].x, cur[0].y - cur[1].y);
      s = Math.min(8, Math.max(1, start.s * d1 / d0));
      tx = start.tx + ((cur[0].x + cur[1].x) - (st[0].x + st[1].x)) / 2;
      ty = start.ty + ((cur[0].y + cur[1].y) - (st[0].y + st[1].y)) / 2;
    } else if (cur.length === 1 && st.length === 1) {
      tx = start.tx + cur[0].x - st[0].x;
      ty = start.ty + cur[0].y - st[0].y;
    }
    apply();
  });
  const up = e => {
    pts.delete(e.pointerId);
    start = { s, tx, ty, pts: new Map([...pts].map(([k, v]) => [k, { ...v }])) };
    if (!pts.size && s <= 1.01) { s = 1; tx = ty = 0; apply(); }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
}

// ---------- sketch pad ----------
const INKS = ['#1d2230', '#e5484d', '#f08c00', '#f5c400', '#2f9e44', '#1c7ed6', '#7048e8', '#ffffff'];
const SIZES = [2, 5, 12];

export function sketchPad(existingBlobId) {
  return new Promise(async resolve => {
    let saved = null;
    const o = layer('sketchpad', () => resolve(saved));
    const canvas = h('canvas', { class: 'sketch-canvas' });
    const ctx = canvas.getContext('2d');
    let base = null;
    if (existingBlobId) {
      const b = await db.getBlob(existingBlobId);
      if (b) base = await createImageBitmap(b);
    }
    const stage = h('div', { class: 'sketch-stage' }, canvas);
    let ink = INKS[0], size = SIZES[1], tool = 'pen';
    const strokes = [];
    let current = null;

    const tools = h('div', { class: 'sketch-tools' });
    const inkRow = h('div', { class: 'sketch-row' });
    const drawTools = () => {
      inkRow.innerHTML = '';
      for (const c of INKS) inkRow.append(h('button', { class: `ink ${c === ink && tool !== 'eraser' ? 'active' : ''}`, style: { background: c }, 'aria-label': `Ink ${c}`, onclick: () => { ink = c; if (tool === 'eraser') tool = 'pen'; drawTools(); } }));
      inkRow.append(h('span', { class: 'sketch-sep' }));
      for (const sz of SIZES) inkRow.append(h('button', { class: `size ${sz === size ? 'active' : ''}`, 'aria-label': `Size ${sz}`, onclick: () => { size = sz; drawTools(); } }, h('span', { style: { width: `${sz + 4}px`, height: `${sz + 4}px` } })));
      inkRow.append(h('span', { class: 'sketch-sep' }));
      inkRow.append(h('button', { class: `icon-btn ${tool === 'marker' ? 'active' : ''}`, 'aria-label': 'Highlighter', html: icon('sketch'), onclick: () => { tool = tool === 'marker' ? 'pen' : 'marker'; drawTools(); } }));
      inkRow.append(h('button', { class: `icon-btn ${tool === 'eraser' ? 'active' : ''}`, 'aria-label': 'Eraser', html: icon('eraser'), onclick: () => { tool = tool === 'eraser' ? 'pen' : 'eraser'; drawTools(); } }));
    };
    drawTools();
    tools.append(inkRow);

    const top = h('div', { class: 'sketch-top' },
      h('button', { class: 'btn', onclick: () => o.close() }, 'Cancel'),
      h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'aria-label': 'Undo stroke', html: icon('undo'), onclick: () => { strokes.pop(); redraw(); } }),
      h('button', { class: 'btn', onclick: () => { strokes.length = 0; base = null; redraw(); } }, 'Clear'),
      h('button', { class: 'btn btn-primary', onclick: save }, 'Save'),
    );
    o.el.append(top, stage, tools);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W, H;
    const size0 = () => {
      const r = stage.getBoundingClientRect();
      W = Math.round(r.width); H = Math.round(r.height);
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      redraw();
    };
    function drawStroke(st) {
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (st.tool === 'eraser') { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = st.size * 3; }
      else if (st.tool === 'marker') { ctx.strokeStyle = st.ink; ctx.globalAlpha = 0.35; ctx.lineWidth = st.size * 3; }
      else { ctx.strokeStyle = st.ink; ctx.lineWidth = st.size; }
      const p = st.pts;
      ctx.beginPath();
      ctx.moveTo(p[0].x, p[0].y);
      if (p.length === 1) ctx.lineTo(p[0].x + 0.1, p[0].y + 0.1);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i].x + p[i + 1].x) / 2, my = (p[i].y + p[i + 1].y) / 2;
        ctx.quadraticCurveTo(p[i].x, p[i].y, mx, my);
      }
      if (p.length > 1) ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
      ctx.stroke();
      ctx.restore();
    }
    function redraw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      if (base) {
        // Previous drawing, at its original size where it fits, centred.
        const fit = Math.min(W / (base.width / dpr), H / (base.height / dpr), 1);
        const bw = (base.width / dpr) * fit, bh = (base.height / dpr) * fit;
        ctx.drawImage(base, (W - bw) / 2, (H - bh) / 2, bw, bh);
      }
      for (const st of strokes) drawStroke(st);
      if (current) drawStroke(current);
    }
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      current = { ink, size, tool, pts: [{ x: e.clientX - r.left, y: e.clientY - r.top }] };
      redraw();
    });
    canvas.addEventListener('pointermove', e => {
      if (!current) return;
      const r = canvas.getBoundingClientRect();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs) current.pts.push({ x: ev.clientX - r.left, y: ev.clientY - r.top });
      redraw();
    });
    const end = () => { if (current) { strokes.push(current); current = null; redraw(); } };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    requestAnimationFrame(size0);

    async function save() {
      if (!strokes.length && !base) { toast('Draw something first'); return; }
      // Crop to the drawn area so the card isn't mostly blank paper.
      const out = cropCanvas(canvas, dpr);
      const blob = await new Promise(r => out.canvas.toBlob(r, 'image/png'));
      const blobId = await saveBlob(blob, 'sketch.png');
      saved = { blobId, w: out.w, h: out.h };
      o.close();
    }
  });
}

function cropCanvas(canvas, dpr) {
  const ctx = canvas.getContext('2d');
  const { width: W, height: H } = canvas;
  const data = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
  const pad = 24 * dpr;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1, hh = y1 - y0 + 1;
  const c = document.createElement('canvas');
  c.width = w; c.height = hh;
  c.getContext('2d').drawImage(canvas, x0, y0, w, hh, 0, 0, w, hh);
  return { canvas: c, w, h: hh };
}

// ---------- voice recorder ----------
export function recordVoice() {
  return new Promise(resolve => {
    let result = null, recorder = null, stream = null, chunks = [], startAt = 0, timer = null, blob = null;
    const time = h('div', { class: 'rec-time' }, '0:00');
    const status = h('p', { class: 'sheet-text muted' }, 'Tap the button to start recording.');
    const preview = h('audio', { controls: true, class: 'rec-preview', hidden: true });
    const name = h('input', { class: 'field', type: 'text', placeholder: 'Voice note' });
    const btn = h('button', { class: 'rec-btn', 'aria-label': 'Start recording', html: icon('mic') });
    const fmt = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    btn.addEventListener('click', async () => {
      if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        status.textContent = 'Microphone access was blocked. Allow it in the browser’s site settings, then try again.';
        return;
      }
      chunks = [];
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        clearInterval(timer);
        stream.getTracks().forEach(t => t.stop());
        blob = new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
        preview.src = URL.createObjectURL(blob);
        preview.hidden = false;
        btn.classList.remove('recording');
        btn.innerHTML = icon('mic');
        status.textContent = 'Listen back, then save. Tap the button again to record over it.';
      };
      recorder.start(250);
      startAt = Date.now();
      timer = setInterval(() => { time.textContent = fmt(Date.now() - startAt); }, 250);
      btn.classList.add('recording');
      btn.innerHTML = icon('stop');
      status.textContent = 'Recording… tap to stop.';
      preview.hidden = true;
    });
    sheet({
      title: 'Voice note',
      body: [h('div', { class: 'rec-wrap' }, btn, time), status, preview, field('Name', name)],
      actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
        if (recorder && recorder.state === 'recording') { toast('Stop the recording first'); return false; }
        if (!blob) { toast('Record something first'); return false; }
        const blobId = await saveBlob(blob, 'voice-note');
        result = { blobId, name: name.value.trim() || `Voice note ${new Date().toLocaleDateString()}`, mime: blob.type, size: blob.size };
      } }],
      onClose: () => {
        clearInterval(timer);
        if (recorder && recorder.state === 'recording') { recorder.onstop = null; recorder.stop(); }
        stream && stream.getTracks().forEach(t => t.stop());
        resolve(result);
      },
    });
  });
}

export { isUrl };
