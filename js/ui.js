import { state, getSelected } from './state.js';

// ─── CROP STATE ───────────────────────────────────────────────
let cropMode = false;
let cropRect = null;    // working rect in source image pixels { x,y,w,h }
let cropDrag = null;    // { type, startMx, startMy, startRect }
let previewScale = 1;
let previewOx = 0;
let previewOy = 0;

// ─── FILMSTRIP ────────────────────────────────────────────────
export function renderFilmstrip() {
  const strip = document.getElementById('filmstrip');
  const addBtn = document.getElementById('filmAdd');
  strip.querySelectorAll('.film-item').forEach(el => el.remove());

  for (const item of state.queue) {
    const el = document.createElement('div');
    el.className = 'film-item' +
      (item.id === state.selectedId ? ' selected' : '') +
      (item.status === 'done' ? ' done' : '');
    el.dataset.id = item.id;
    el.title = item.name;

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.className = 'film-canvas';
    thumbCanvas.width = 133; thumbCanvas.height = 80;
    el.appendChild(thumbCanvas);

    const label = document.createElement('div');
    label.className = 'film-label';
    label.textContent = item.name;
    el.appendChild(label);

    const dots = document.createElement('div');
    dots.className = 'film-dots';
    appendStatusDots(dots, item);
    el.appendChild(dots);

    el.addEventListener('click', () => {
      if (state.selectedId !== item.id) selectItem(item.id);
    });
    strip.insertBefore(el, addBtn);
    drawFilmThumb(item, thumbCanvas);
  }
}

export function refreshFilmItem(item) {
  const el = document.querySelector(`.film-item[data-id="${item.id}"]`);
  if (!el) return;
  el.className = 'film-item' +
    (item.id === state.selectedId ? ' selected' : '') +
    (item.status === 'done' ? ' done' : '');
  const tc = el.querySelector('canvas');
  if (tc) drawFilmThumb(item, tc);
  const dots = el.querySelector('.film-dots');
  if (dots) { dots.innerHTML = ''; appendStatusDots(dots, item); }
}

function appendStatusDots(container, item) {
  if (item.cropRect) {
    const d = document.createElement('div');
    d.className = 'film-dot crop'; d.title = 'Crop applied';
    container.appendChild(d);
  }
  if (item.status === 'done') {
    const d = document.createElement('div');
    d.className = 'film-dot done'; d.title = 'Processed';
    container.appendChild(d);
  }
  if (item.status === 'error') {
    const d = document.createElement('div');
    d.className = 'film-dot error'; d.title = 'Error';
    container.appendChild(d);
  }
}

function drawFilmThumb(item, canvas) {
  if (!item.sourceCanvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const iw = item.sourceCanvas.width, ih = item.sourceCanvas.height;
  const s = Math.min(W / iw, H / ih);
  const dw = iw * s, dh = ih * s;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(item.sourceCanvas, 0, 0, iw, ih, ox, oy, dw, dh);

  if (item.cropRect) {
    const { x, y, w, h } = item.cropRect;
    const cx = ox + x * s, cy = oy + y * s, cw = w * s, ch = h * s;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, W, cy);
    ctx.fillRect(0, cy + ch, W, H - cy - ch);
    ctx.fillRect(0, cy, cx, ch);
    ctx.fillRect(cx + cw, cy, W - cx - cw, ch);
    ctx.strokeStyle = 'rgba(232,213,163,0.8)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx, cy, cw, ch);
  }
}

// ─── QUEUE HELPERS ────────────────────────────────────────────
export function selectItem(id) {
  if (cropMode) cancelCrop();
  state.selectedId = id;
  document.querySelectorAll('.film-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  renderPreview();
  updateUIState();
}

export function showDropZone(visible) {
  const dz = document.getElementById('dropZone');
  dz.classList.toggle('active', visible);
  dz.style.display = visible ? 'flex' : 'none';
}

export function updateUIState() {
  const hasItems = state.queue.length > 0;
  const hasDone = state.queue.some(q => q.status === 'done');
  const item = getSelected();

  showDropZone(!hasItems);
  document.getElementById('selectionHint').style.display =
    hasItems && !item ? 'flex' : 'none';

  // Export button
  document.getElementById('exportBtn').disabled = !hasItems || state.isProcessing;

  // Crop controls shown only in image tab with a selection
  const inImage = state.viewTab === 'image';
  const cropControlsEl = document.getElementById('cropControls');
  cropControlsEl.style.display = inImage && item ? 'flex' : 'none';

  if (item) {
    document.getElementById('resetCropBtn').style.display =
      item.cropRect ? 'inline-flex' : 'none';
  }

  // 3D controls
  const in3d = state.viewTab === '3d';
  document.getElementById('controls3d').style.display = in3d ? 'flex' : 'none';
  document.getElementById('envBar').style.display = in3d ? 'flex' : 'none';
  document.getElementById('debugPanel').style.display = in3d ? 'flex' : 'none';
}

export function updateStats() {
  const total = state.queue.length;
  const done = state.queue.filter(q => q.status === 'done').length;
  const pending = state.queue.filter(q => q.status === 'pending').length;
  const el = document.getElementById('statsText');
  if (el) el.textContent = total ? `${done}/${total} processed` : '';
}

// ─── 2D PREVIEW CANVAS ───────────────────────────────────────
export function renderPreview() {
  const canvas = document.getElementById('canvas2d');
  const item = getSelected();
  const hint = document.getElementById('selectionHint');

  if (state.viewTab !== 'image') return;

  canvas.style.display = 'block';

  if (!item) {
    hint.style.display = state.queue.length > 0 ? 'flex' : 'none';
    canvas.style.display = 'none';
    return;
  }

  hint.style.display = 'none';
  canvas.style.display = 'block';

  const area = document.getElementById('viewArea');
  const areaW = area.clientWidth, areaH = area.clientHeight;
  canvas.width = areaW; canvas.height = areaH;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, areaW, areaH);

  if (!item.sourceCanvas) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.font = '13px "DM Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Loading…', areaW / 2, areaH / 2);
    return;
  }

  if (cropMode) {
    renderCropOverlay(ctx, item, areaW, areaH);
  } else {
    renderSourceView(ctx, item.sourceCanvas, areaW, areaH);
  }
}

function renderSourceView(ctx, srcCanvas, areaW, areaH) {
  const { s, ox, oy, dw, dh } = computeContain(srcCanvas.width, srcCanvas.height, areaW, areaH);
  previewScale = s; previewOx = ox; previewOy = oy;
  drawCheckerboard(ctx, ox, oy, dw, dh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(srcCanvas, ox, oy, dw, dh);
}

function renderCropOverlay(ctx, item, areaW, areaH) {
  const src = item.sourceCanvas;
  const { s, ox, oy, dw, dh } = computeContain(src.width, src.height, areaW, areaH);
  previewScale = s; previewOx = ox; previewOy = oy;

  drawCheckerboard(ctx, ox, oy, dw, dh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(src, ox, oy, dw, dh);

  if (!cropRect) return;

  const cx = ox + cropRect.x * s, cy = oy + cropRect.y * s;
  const cw = cropRect.w * s, ch = cropRect.h * s;

  // Darken outside crop
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, areaW, cy);
  ctx.fillRect(0, cy + ch, areaW, areaH - cy - ch);
  ctx.fillRect(0, cy, cx, ch);
  ctx.fillRect(cx + cw, cy, areaW - cx - cw, ch);

  // Rule of thirds
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 0.75;
  ctx.setLineDash([4, 4]);
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(cx + cw*i/3, cy); ctx.lineTo(cx + cw*i/3, cy + ch); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + ch*i/3); ctx.lineTo(cx + cw, cy + ch*i/3); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // Crop border
  ctx.strokeStyle = 'rgba(232,213,163,0.95)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx, cy, cw, ch);

  // Corner handles
  const hs = 8;
  ctx.fillStyle = '#e8d5a3';
  for (const [hx, hy] of [[cx,cy],[cx+cw,cy],[cx,cy+ch],[cx+cw,cy+ch]]) {
    ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
  }

  // Size info
  const sizeInfo = document.getElementById('cropSizeInfo');
  sizeInfo.textContent =
    `${Math.round(cropRect.w)} × ${Math.round(cropRect.h)}  →  ${state.resolution.w} × ${state.resolution.h}`;
}

function computeContain(imgW, imgH, areaW, areaH) {
  const s = Math.min(areaW / imgW, areaH / imgH);
  const dw = imgW * s, dh = imgH * s;
  const ox = (areaW - dw) / 2, oy = (areaH - dh) / 2;
  return { s, ox, oy, dw, dh };
}

function drawCheckerboard(ctx, x, y, w, h) {
  const sz = 14;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  for (let cy = y; cy < y + h; cy += sz) for (let cx = x; cx < x + w; cx += sz) {
    ctx.fillStyle = (Math.floor((cx - x) / sz) + Math.floor((cy - y) / sz)) % 2 === 0
      ? '#1a1b1e' : '#141516';
    ctx.fillRect(cx, cy, sz, sz);
  }
  ctx.restore();
}

// ─── CROP TOOL ────────────────────────────────────────────────
export function enterCropMode() {
  const item = getSelected();
  if (!item || !item.sourceCanvas) return;
  cropMode = true;
  cropRect = item.cropRect ? { ...item.cropRect } : null;
  if (!cropRect) autoFitCrop(item);

  document.getElementById('cropToolbar').style.display = 'flex';
  document.getElementById('cropSizeInfo').style.display = 'block';
  document.getElementById('cropControls').style.display = 'none';
  updateCropRatioLabel();

  const canvas = document.getElementById('canvas2d');
  canvas.addEventListener('mousedown', onCropMouseDown);
  canvas.addEventListener('mousemove', onCropMouseMove);
  canvas.addEventListener('mouseup', onCropMouseUp);
  canvas.addEventListener('mouseleave', onCropMouseUp);
  renderPreview();
}

export function exitCropMode() {
  cropMode = false;
  cropDrag = null;
  document.getElementById('cropToolbar').style.display = 'none';
  document.getElementById('cropSizeInfo').style.display = 'none';
  const canvas = document.getElementById('canvas2d');
  canvas.removeEventListener('mousedown', onCropMouseDown);
  canvas.removeEventListener('mousemove', onCropMouseMove);
  canvas.removeEventListener('mouseup', onCropMouseUp);
  canvas.removeEventListener('mouseleave', onCropMouseUp);
  canvas.style.cursor = 'default';
  updateUIState();
  renderPreview();
}

export function cancelCrop() {
  if (!cropMode) return;
  cropRect = null;
  exitCropMode();
}

export function applyCrop() {
  const item = getSelected();
  if (!item || !cropRect) return;
  item.cropRect = {
    x: Math.round(cropRect.x), y: Math.round(cropRect.y),
    w: Math.round(cropRect.w), h: Math.round(cropRect.h),
  };
  if (item.status === 'done') {
    item.status = 'pending';
    item.ditheredCanvas = null;
    item.deviceCanvas = null;
  }
  exitCropMode();
  refreshFilmItem(item);
  updateStats();
  toast('Crop applied. Switch to 3D view to preview, or Export to process all.', 'info');
}

export function resetCrop() {
  const item = getSelected();
  if (!item) return;
  item.cropRect = null;
  if (item.status === 'done') {
    item.status = 'pending';
    item.ditheredCanvas = null;
    item.deviceCanvas = null;
  }
  refreshFilmItem(item);
  updateUIState();
  renderPreview();
  updateStats();
}

export function autoFitCrop(item) {
  const src = item || getSelected();
  if (!src || !src.sourceCanvas) return;
  const iw = src.sourceCanvas.width, ih = src.sourceCanvas.height;
  const ratio = state.aspectRatio;
  let w, h;
  if (iw / ih >= ratio) { h = ih; w = h * ratio; }
  else { w = iw; h = w / ratio; }
  cropRect = { x: (iw - w) / 2, y: (ih - h) / 2, w, h };
  renderPreview();
}

function updateCropRatioLabel() {
  const label = document.getElementById('cropRatioLabel');
  if (!label) return;
  const r = state.aspectRatio;
  const aspW = document.getElementById('aspW').value;
  const aspH = document.getElementById('aspH').value;
  label.textContent = `✂ ${aspW}:${aspH}`;
}

// ─── CROP MOUSE HANDLERS ──────────────────────────────────────
function getCanvasXY(e) {
  const canvas = document.getElementById('canvas2d');
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function getCropHandle(mx, my) {
  if (!cropRect) return null;
  const cx = previewOx + cropRect.x * previewScale, cy = previewOy + cropRect.y * previewScale;
  const cw = cropRect.w * previewScale, ch = cropRect.h * previewScale;
  const hs = 12;
  if (Math.abs(mx - cx) < hs && Math.abs(my - cy) < hs) return 'nw';
  if (Math.abs(mx - (cx+cw)) < hs && Math.abs(my - cy) < hs) return 'ne';
  if (Math.abs(mx - cx) < hs && Math.abs(my - (cy+ch)) < hs) return 'sw';
  if (Math.abs(mx - (cx+cw)) < hs && Math.abs(my - (cy+ch)) < hs) return 'se';
  if (mx > cx && mx < cx+cw && my > cy && my < cy+ch) return 'move';
  return null;
}

function onCropMouseDown(e) {
  if (!cropRect) return;
  const { x: mx, y: my } = getCanvasXY(e);
  const type = getCropHandle(mx, my);
  if (!type) return;
  cropDrag = { type, startMx: mx, startMy: my, startRect: { ...cropRect } };
  e.preventDefault();
}

function onCropMouseMove(e) {
  const { x: mx, y: my } = getCanvasXY(e);
  const canvas = document.getElementById('canvas2d');

  if (!cropDrag) {
    const h = getCropHandle(mx, my);
    const cursors = { nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize', move: 'move' };
    canvas.style.cursor = h ? (cursors[h] || 'default') : (cropRect ? 'crosshair' : 'default');
    return;
  }

  const item = getSelected();
  if (!item) return;
  const iw = item.sourceCanvas.width, ih = item.sourceCanvas.height;
  const MIN = 40;
  const dx = (mx - cropDrag.startMx) / previewScale;
  const dy = (my - cropDrag.startMy) / previewScale;
  const sr = cropDrag.startRect;
  const ratio = state.aspectRatio;
  let { x, y, w, h } = sr;

  if (cropDrag.type === 'move') {
    x = Math.max(0, Math.min(iw - w, sr.x + dx));
    y = Math.max(0, Math.min(ih - h, sr.y + dy));
  } else if (cropDrag.type === 'se') {
    w = Math.max(MIN, sr.w + dx); h = w / ratio;
    if (x + w > iw) { w = iw - x; h = w / ratio; }
    if (y + h > ih) { h = ih - y; w = h * ratio; }
  } else if (cropDrag.type === 'nw') {
    w = Math.max(MIN, sr.w - dx); h = w / ratio;
    x = sr.x + sr.w - w; y = sr.y + sr.h - h;
    if (x < 0) { x = 0; w = sr.x + sr.w; h = w / ratio; y = sr.y + sr.h - h; }
    if (y < 0) { y = 0; h = sr.y + sr.h; w = h * ratio; x = sr.x + sr.w - w; }
  } else if (cropDrag.type === 'ne') {
    w = Math.max(MIN, sr.w + dx); h = w / ratio;
    y = sr.y + sr.h - h;
    if (x + w > iw) { w = iw - x; h = w / ratio; y = sr.y + sr.h - h; }
    if (y < 0) { y = 0; h = sr.y + sr.h; w = h * ratio; }
  } else if (cropDrag.type === 'sw') {
    w = Math.max(MIN, sr.w - dx); h = w / ratio;
    x = sr.x + sr.w - w;
    if (x < 0) { x = 0; w = sr.x + sr.w; h = w / ratio; }
    if (y + h > ih) { h = ih - y; w = h * ratio; x = sr.x + sr.w - w; }
  }
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (w < MIN) { w = MIN; h = w / ratio; }
  cropRect = { x, y, w, h };
  renderPreview();
  e.preventDefault();
}

function onCropMouseUp() { cropDrag = null; }

// ─── TOAST ────────────────────────────────────────────────────
export function toast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast';
  if (type === 'success') t.style.borderColor = 'rgba(109,189,138,0.4)';
  if (type === 'error') t.style.borderColor = 'rgba(224,108,117,0.4)';
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ─── IMAGE LOADER ─────────────────────────────────────────────
export function loadSourceImage(item) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    item.sourceCanvas = c;
    URL.revokeObjectURL(img.src);
    refreshFilmItem(item);
    if (state.selectedId === item.id) renderPreview();
    updateUIState();
  };
  img.src = URL.createObjectURL(item.file);
}

// ─── CROP STATE ACCESSOR ──────────────────────────────────────
export function isCropMode() { return cropMode; }
