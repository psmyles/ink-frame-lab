import { state, getSelected } from './state.js';

// ─── POST-SELECT HOOK ────────────────────────────────────────
// main.js sets this to trigger processing when firmware view is active
let onSelectCallback = null;
export function setOnSelectCallback(fn) { onSelectCallback = fn; }

// ─── CROP STATE ───────────────────────────────────────────────
let cropEditing = false;     // overlay is interactive (drag enabled)
let cropRect = null;         // working rect in source image pixels
let prevCropRect = null;     // snapshot before entering edit (for Cancel)
let cropDrag = null;
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
    d.className = 'film-dot crop'; d.title = 'Crop set';
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

  // Show saved crop rect in thumbnail
  const cr = item.cropRect;
  if (cr) {
    const cx = ox + cr.x * s, cy = oy + cr.y * s, cw = cr.w * s, ch = cr.h * s;
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
  // Auto-save current working cropRect to the currently selected item
  const prev = getSelected();
  if (prev && cropRect) {
    const r = { x: Math.round(cropRect.x), y: Math.round(cropRect.y), w: Math.round(cropRect.w), h: Math.round(cropRect.h) };
    const changed = !prev.cropRect ||
      prev.cropRect.x !== r.x || prev.cropRect.y !== r.y ||
      prev.cropRect.w !== r.w || prev.cropRect.h !== r.h;
    if (changed) {
      prev.cropRect = r;
      if (prev.status === 'done') { prev.status = 'pending'; prev.ditheredCanvas = null; prev.deviceCanvas = null; }
      refreshFilmItem(prev);
    }
  }

  cropEditing = false;
  cropDrag = null;
  removeCropMouseHandlers();

  state.selectedId = id;
  document.querySelectorAll('.film-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });

  // Load crop for the new item, or compute auto-fit
  const item = state.queue.find(q => q.id === id);
  if (item) {
    if (item.cropRect) {
      cropRect = { ...item.cropRect };
    } else if (item.sourceCanvas) {
      cropRect = computeAutoFit(item.sourceCanvas);
    } else {
      cropRect = null;
    }
  }

  updateCropToolbar();
  renderPreview();
  updateUIState();
  if (onSelectCallback) onSelectCallback(id);
}

export function showDropZone(visible) {
  const dz = document.getElementById('dropZone');
  dz.classList.toggle('active', visible);
  dz.style.display = visible ? 'flex' : 'none';
}

export function updateUIState() {
  const hasItems = state.queue.length > 0;
  const item = getSelected();

  showDropZone(!hasItems);
  document.getElementById('selectionHint').style.display =
    hasItems && !item ? 'flex' : 'none';

  const exportDisabled = !hasItems || state.isProcessing;
  document.getElementById('exportFilesBtn').disabled   = exportDisabled;
  document.getElementById('exportZipBtn').disabled     = exportDisabled;
  document.getElementById('exportCurrentBtn').disabled = !item || state.isProcessing;

  // Crop toolbar: always shown in image view when an image is selected
  const inImage = state.viewTab === 'image';
  const cropToolbar = document.getElementById('cropToolbar');
  cropToolbar.style.display = inImage && item ? 'flex' : 'none';
  if (inImage && item) updateCropToolbar();

  // Crop size info: only in edit mode
  document.getElementById('cropSizeInfo').style.display =
    inImage && item && cropEditing ? 'block' : 'none';

  // 3D controls
  const in3d = state.viewTab === '3d';
  document.getElementById('controls3d').style.display      = in3d ? 'flex' : 'none';
  document.getElementById('iblPicker').style.display       = in3d ? 'flex' : 'none';
  document.getElementById('framePanelSection').style.display = in3d ? '' : 'none';
}

function updateCropToolbar() {
  const btnEdit  = document.getElementById('btnEditCrop');
  const btnApply = document.getElementById('btnApplyCrop');
  const btnCancel = document.getElementById('btnCancelCrop');

  if (cropEditing) {
    btnEdit.style.display  = 'none';
    btnApply.style.display = 'inline-flex';
    btnCancel.style.display = 'inline-flex';
  } else {
    btnEdit.style.display  = 'inline-flex';
    btnApply.style.display = 'none';
    btnCancel.style.display = 'none';
  }
  updateCropRatioLabel();
}

function updateCropRatioLabel() {
  const label = document.getElementById('cropRatioLabel');
  if (!label) return;
  const { w, h } = state.resolution;
  const d = gcdUi(Math.round(w), Math.round(h));
  label.textContent = `${Math.round(w / d)}:${Math.round(h / d)}`;
}

function gcdUi(a, b) { return b ? gcdUi(b, a % b) : a; }

export function updateStats() {
  const total = state.queue.length;
  const done  = state.queue.filter(q => q.status === 'done').length;
  const el    = document.getElementById('statsText');
  if (el) el.textContent = total ? `${done}/${total} processed` : '';
}

// ─── IMAGE VIEW CANVAS ────────────────────────────────────────
export function renderPreview() {
  if (state.viewTab !== 'image') return;

  const canvas = document.getElementById('canvas2d');
  const item = getSelected();
  const hint = document.getElementById('selectionHint');

  if (!item) {
    canvas.style.display = 'none';
    hint.style.display = state.queue.length > 0 ? 'flex' : 'none';
    return;
  }

  hint.style.display = 'none';
  canvas.style.display = 'block';

  const area  = document.getElementById('viewArea');
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

  // Ensure we have a crop rect to show
  if (!cropRect) cropRect = computeAutoFit(item.sourceCanvas);

  renderCropView(ctx, item, areaW, areaH);
}

// ─── FIRMWARE VIEW CANVAS ─────────────────────────────────────
export function renderFirmwareView() {
  if (state.viewTab !== 'firmware') return;

  const canvas = document.getElementById('canvasFirmware');
  const item = getSelected();

  if (!item) { canvas.style.display = 'none'; return; }
  canvas.style.display = 'block';

  const area  = document.getElementById('viewArea');
  const areaW = area.clientWidth, areaH = area.clientHeight;
  canvas.width = areaW; canvas.height = areaH;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, areaW, areaH);

  if (!item.deviceCanvas) {
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.font = '13px "DM Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Processing…', areaW / 2, areaH / 2);
    return;
  }

  const { s, ox, oy, dw, dh } = computeContain(item.deviceCanvas.width, item.deviceCanvas.height, areaW, areaH);
  drawCheckerboard(ctx, ox, oy, dw, dh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(item.deviceCanvas, ox, oy, dw, dh);
}

function renderCropView(ctx, item, areaW, areaH) {
  const src = item.sourceCanvas;
  const { s, ox, oy, dw, dh } = computeContain(src.width, src.height, areaW, areaH);
  previewScale = s; previewOx = ox; previewOy = oy;

  drawCheckerboard(ctx, ox, oy, dw, dh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(src, ox, oy, dw, dh);

  if (!cropRect) return;

  const cx = ox + cropRect.x * s, cy = oy + cropRect.y * s;
  const cw = cropRect.w * s,      ch = cropRect.h * s;

  // Darken outside crop
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, areaW, cy);
  ctx.fillRect(0, cy + ch, areaW, areaH - cy - ch);
  ctx.fillRect(0, cy, cx, ch);
  ctx.fillRect(cx + cw, cy, areaW - cx - cw, ch);

  if (cropEditing) {
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
  }

  // Crop border — brighter when editing
  ctx.strokeStyle = cropEditing ? 'rgba(232,213,163,0.95)' : 'rgba(232,213,163,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx, cy, cw, ch);

  // Corner handles — only in edit mode
  if (cropEditing) {
    const hs = 8;
    ctx.fillStyle = '#e8d5a3';
    for (const [hx, hy] of [[cx,cy],[cx+cw,cy],[cx,cy+ch],[cx+cw,cy+ch]]) {
      ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
    }
  }

  // Size info
  if (cropEditing) {
    const sizeInfo = document.getElementById('cropSizeInfo');
    if (sizeInfo) sizeInfo.textContent =
      `${Math.round(cropRect.w)} × ${Math.round(cropRect.h)}  →  ${state.resolution.w} × ${state.resolution.h}`;
  }
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

// ─── CROP ACTIONS ─────────────────────────────────────────────
export function startCropEdit() {
  const item = getSelected();
  if (!item || !item.sourceCanvas) return;
  if (!cropRect) cropRect = computeAutoFit(item.sourceCanvas);
  prevCropRect = cropRect ? { ...cropRect } : null;
  cropEditing = true;
  updateCropToolbar();
  document.getElementById('cropSizeInfo').style.display = 'block';
  addCropMouseHandlers();
  renderPreview();
}

export function applyAndExitCropEdit() {
  const item = getSelected();
  if (!item || !cropRect) return;
  item.cropRect = { x: Math.round(cropRect.x), y: Math.round(cropRect.y), w: Math.round(cropRect.w), h: Math.round(cropRect.h) };
  if (item.status === 'done') { item.status = 'pending'; item.ditheredCanvas = null; item.deviceCanvas = null; }
  cropEditing = false;
  prevCropRect = null;
  removeCropMouseHandlers();
  document.getElementById('cropSizeInfo').style.display = 'none';
  updateCropToolbar();
  refreshFilmItem(item);
  updateStats();
  renderPreview();
}

export function cancelCropEdit() {
  cropRect = prevCropRect;
  prevCropRect = null;
  cropEditing = false;
  removeCropMouseHandlers();
  document.getElementById('cropSizeInfo').style.display = 'none';
  updateCropToolbar();
  renderPreview();
}

export function doAutoFit() {
  const item = getSelected();
  if (!item || !item.sourceCanvas) return;
  cropRect = computeAutoFit(item.sourceCanvas);
  // If not in edit mode, immediately save
  if (!cropEditing) {
    item.cropRect = { ...cropRect };
    if (item.status === 'done') { item.status = 'pending'; item.ditheredCanvas = null; item.deviceCanvas = null; }
    refreshFilmItem(item);
    updateStats();
  }
  renderPreview();
}

export function doResetCrop() {
  const item = getSelected();
  if (!item || !item.sourceCanvas) return;
  cropRect = computeAutoFit(item.sourceCanvas);
  item.cropRect = { ...cropRect };
  if (item.status === 'done') { item.status = 'pending'; item.ditheredCanvas = null; item.deviceCanvas = null; }
  refreshFilmItem(item);
  updateStats();
  renderPreview();
}

function computeAutoFit(sourceCanvas) {
  const iw = sourceCanvas.width, ih = sourceCanvas.height;
  const ratio = state.aspectRatio;
  let w, h;
  if (iw / ih >= ratio) { h = ih; w = h * ratio; }
  else { w = iw; h = w / ratio; }
  return { x: (iw - w) / 2, y: (ih - h) / 2, w, h };
}

// ─── CROP MOUSE HANDLERS ──────────────────────────────────────
function addCropMouseHandlers() {
  const c = document.getElementById('canvas2d');
  c.addEventListener('mousedown', onCropMouseDown);
  c.addEventListener('mousemove', onCropMouseMove);
  c.addEventListener('mouseup', onCropMouseUp);
  c.addEventListener('mouseleave', onCropMouseUp);
}

function removeCropMouseHandlers() {
  const c = document.getElementById('canvas2d');
  c.removeEventListener('mousedown', onCropMouseDown);
  c.removeEventListener('mousemove', onCropMouseMove);
  c.removeEventListener('mouseup', onCropMouseUp);
  c.removeEventListener('mouseleave', onCropMouseUp);
  c.style.cursor = 'default';
  cropDrag = null;
}

function getCanvasXY(e) {
  const c = document.getElementById('canvas2d');
  const rect = c.getBoundingClientRect();
  const sx = c.width / rect.width, sy = c.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function getCropHandle(mx, my) {
  if (!cropRect) return null;
  const cx = previewOx + cropRect.x * previewScale, cy = previewOy + cropRect.y * previewScale;
  const cw = cropRect.w * previewScale, ch = cropRect.h * previewScale;
  const hs = 12;
  if (Math.abs(mx - cx)        < hs && Math.abs(my - cy)        < hs) return 'nw';
  if (Math.abs(mx - (cx + cw)) < hs && Math.abs(my - cy)        < hs) return 'ne';
  if (Math.abs(mx - cx)        < hs && Math.abs(my - (cy + ch)) < hs) return 'sw';
  if (Math.abs(mx - (cx + cw)) < hs && Math.abs(my - (cy + ch)) < hs) return 'se';
  if (mx > cx && mx < cx + cw && my > cy && my < cy + ch) return 'move';
  return null;
}

function onCropMouseDown(e) {
  if (!cropRect || !cropEditing) return;
  const { x: mx, y: my } = getCanvasXY(e);
  const type = getCropHandle(mx, my);
  if (!type) return;
  cropDrag = { type, startMx: mx, startMy: my, startRect: { ...cropRect } };
  e.preventDefault();
}

function onCropMouseMove(e) {
  if (!cropEditing) return;
  const { x: mx, y: my } = getCanvasXY(e);
  const c = document.getElementById('canvas2d');

  if (!cropDrag) {
    const h = getCropHandle(mx, my);
    const cursors = { nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize', move: 'move' };
    c.style.cursor = h ? (cursors[h] || 'default') : 'crosshair';
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
  if (type === 'error')   t.style.borderColor = 'rgba(224,108,117,0.4)';
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

    // Always give the item a crop rect so getCroppedCanvas never has to stretch
    if (!item.cropRect) {
      const af = computeAutoFit(c);
      item.cropRect = { x: Math.round(af.x), y: Math.round(af.y), w: Math.round(af.w), h: Math.round(af.h) };
    }

    // Sync module-level cropRect for the selected item
    if (state.selectedId === item.id) {
      cropRect = { ...item.cropRect };
    }

    refreshFilmItem(item);
    if (state.selectedId === item.id) renderPreview();
    updateUIState();
  };
  img.src = URL.createObjectURL(item.file);
}
